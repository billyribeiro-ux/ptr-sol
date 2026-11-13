"""Internal recording finalizer. It only reads files within a recording UUID."""
import hmac
import base64
import urllib.request
import urllib.error
import json
import os
import pathlib
import re
import subprocess
import socket
import tempfile
import secrets
import time
from urllib.parse import urlparse
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(os.environ.get('RECORDINGS_DIR', '/app/data/recordings')).resolve()
TOKEN = os.environ.get('MEDIA_PROCESSOR_TOKEN', '')
LOCK = threading.Lock()

def run(args, timeout=300):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    if result.returncode:
        raise ValueError('Media conversion failed: ' + result.stderr.decode(errors='replace')[-1000:])
    return result.stdout

def probe(file):
    return json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(file)], 30))

def process(recording_id):
    if not isinstance(recording_id, str) or not re.fullmatch(r'[a-fA-F0-9-]{36}', recording_id):
        raise ValueError('Invalid recording ID')
    folder = (ROOT / recording_id).resolve()
    if folder.parent != ROOT or not folder.is_dir():
        raise ValueError('Recording not found')
    videos = []
    for source in sorted(folder.glob('*.mjr')):
        if source.is_symlink() or source.stat().st_size < 100:
            continue
        with source.open('rb') as handle:
            if handle.read(8) != b'MJR00002':
                continue
            size = int.from_bytes(handle.read(2), 'big')
            if size > 65535:
                raise ValueError('Invalid MJR header')
            header = json.loads(handle.read(size))
        if header.get('t') != 'v':
            continue
        codec = header.get('c')
        extension = 'webm' if codec in ('vp8', 'vp9') else 'h264' if codec == 'h264' else None
        if not extension:
            raise ValueError('Unsupported recording codec')
        target = source.with_suffix('.' + extension)
        run(['janus-pp-rec', '-d', '1', str(source), str(target)])
        if target.is_file() and target.stat().st_size:
            info = probe(target)
            if any(stream['codec_type'] == 'video' for stream in info.get('streams', [])):
                videos.append((target, source.stat().st_size))
    audio = folder / 'audio.wav'
    has_audio = audio.is_file() and audio.stat().st_size > 44
    if not videos and not has_audio:
        raise ValueError('No recorded media was produced')
    # The primary presentation is the largest received video track. Auxiliary
    # camera tracks remain available beside the exported recording for migration.
    primary = max(videos, key=lambda item: item[1])[0] if videos else None
    output = folder / ('recording.mp4' if primary else 'recording.m4a')
    temporary = folder / ('processing.mp4' if primary else 'processing.m4a')
    args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
    if primary:
        args += ['-i', str(primary)]
    if has_audio:
        args += ['-i', str(audio)]
    if primary:
        args += ['-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2']
        if has_audio:
            args += ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-af', 'apad', '-shortest']
        else:
            args += ['-an']
    else:
        args += ['-vn', '-c:a', 'aac', '-b:a', '128k']
    args += ['-movflags', '+faststart', str(temporary)]
    run(args, 1800)
    metadata = probe(temporary)
    duration = float(metadata.get('format', {}).get('duration', 0))
    if duration <= 0 or not metadata.get('streams'):
        raise ValueError('Recording contains no playable media')
    temporary.replace(output)
    return {'success': True, 'file': str(output), 'durationSec': duration,
            'size': output.stat().st_size, 'mimeType': 'video/mp4' if primary else 'audio/mp4'}

# Live relays are private to this process and are not restored after a restart:
# the corresponding Janus forwarders are cleaned up by the application.
RELAYS = {}
RELAY_LOCK = threading.RLock()
RELAY_PORT_START = int(os.environ.get('RELAY_PORT_START', '30000'))
RELAY_PORT_END = int(os.environ.get('RELAY_PORT_END', '30999'))

def collect_safe_errors(proc,item,lock):
    try:
        for line in proc.stderr:
            clean=re.sub(r'(?i)rtmps?://[^\s]+','[stream destination]',line)
            clean=re.sub(r'(?i)(?:user|pass|token|key)=[^\s&]+','[redacted]',clean)
            clean=re.sub(r'(?i)(?:live/)[A-Za-z0-9_-]{12,}','live/[redacted]',clean)
            with lock:item['last_error']=clean.strip()[-400:]
    except (OSError,ValueError):pass

def valid_relay_id(value):
    if not isinstance(value,str) or not re.fullmatch(r'[a-f0-9-]{36}',value):
        raise ValueError('Invalid relay ID')
    return value

def reserve_relay(relay_id):
    relay_id=valid_relay_id(relay_id)
    with RELAY_LOCK:
        if relay_id in RELAYS: raise ValueError('Relay already exists')
        used={p for item in RELAYS.values() for p in (item['video_port'],item['video_port']+1,item['audio_port'],item['audio_port']+1)}
        for base in range(RELAY_PORT_START+(RELAY_PORT_START%2), RELAY_PORT_END-3, 4):
            ports=range(base,base+4)
            if any(p in used for p in ports): continue
            sockets=[]
            try:
                for port in ports:
                    sk=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);sk.bind(('0.0.0.0',port));sockets.append(sk)
            except OSError:
                for sk in sockets: sk.close()
                continue
            for sk in sockets: sk.close()
            RELAYS[relay_id]={'video_port':base,'audio_port':base+2,'state':'reserved','process':None,'sdp':None,'last_error':'','started':time.monotonic(),'last_seen':time.monotonic(),'last_frame':0,'frame':0}
            return {'success':True,'videoPort':base,'audioPort':base+2,'state':'reserved'}
    raise ValueError('No relay ports are available')

def validate_destination(value):
    if not isinstance(value,str) or len(value)>2048 or any(ord(c)<32 for c in value): raise ValueError('Invalid stream destination')
    url=urlparse(value)
    if url.scheme not in ('rtmp','rtmps') or not url.hostname or url.username or url.password or url.fragment or url.query: raise ValueError('Invalid stream destination')
    try: port=url.port or (443 if url.scheme=='rtmps' else 1935)
    except ValueError: raise ValueError('Invalid stream destination')
    allowed={'a.rtmp.youtube.com:1935','b.rtmp.youtube.com:1935','live-api-s.facebook.com:443'}
    allowed.update(x.strip().lower() for x in os.environ.get('STREAM_LOCAL_ALLOWLIST','').split(',') if x.strip())
    if f'{url.hostname.lower()}:{port}' not in allowed: raise ValueError('Stream destination is not allowed')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]{1,1000}',url.path) or '..' in url.path.split('/'): raise ValueError('Invalid stream path')
    return value

def start_relay(relay_id,destination):
    relay_id=valid_relay_id(relay_id);destination=validate_destination(destination)
    with RELAY_LOCK:
        item=RELAYS.get(relay_id)
        if not item or item['state']!='reserved': raise ValueError('Relay not reserved')
        sdp='v=0\no=- 0 0 IN IP4 127.0.0.1\ns=PTR relay\nc=IN IP4 0.0.0.0\nt=0 0\nm=video %d RTP/AVP 96\na=rtpmap:96 VP8/90000\nm=audio %d RTP/AVP 111\na=rtpmap:111 opus/48000/2\n' % (item['video_port'],item['audio_port'])
        fd,sdpfile=tempfile.mkstemp(prefix='ptr-relay-',suffix='.sdp');os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as handle: handle.write(sdp)
        # Destination is passed directly to ffmpeg (never shell-interpreted, persisted,
        # returned, or logged). Access to this private container must be restricted.
        args=['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file,udp,rtp','-fflags','+genpts','-i',sdpfile,'-map','0:v:0','-map','0:a:0','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-f','flv','-progress','pipe:1',destination]
        try: proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
        except OSError:
            os.unlink(sdpfile);RELAYS.pop(relay_id,None);raise
        item.update(state='starting',process=proc,sdp=sdpfile,started=time.monotonic())
        threading.Thread(target=collect_safe_errors,args=(proc,item,RELAY_LOCK),daemon=True).start()
        def watch():
            try:
                for line in proc.stdout:
                    if line.startswith('frame='):
                        frame=int(line.partition('=')[2].strip() or '0')
                        with RELAY_LOCK:
                            if relay_id in RELAYS and RELAYS[relay_id]['process'] is proc and frame>RELAYS[relay_id]['frame']:
                                RELAYS[relay_id].update(state='streaming',frame=frame,last_frame=time.monotonic(),last_error='')
            except (ValueError,OSError): pass
            code=proc.wait()
            with RELAY_LOCK:
                if relay_id in RELAYS and RELAYS[relay_id]['process'] is proc: RELAYS[relay_id]['state']='failed' if code else 'stopped'
        threading.Thread(target=watch,daemon=True).start()
        return {'success':True,'state':'starting'}

def relay_status(relay_id):
    relay_id=valid_relay_id(relay_id)
    with RELAY_LOCK:
        item=RELAYS.get(relay_id)
        if not item: return {'success':False,'state':'missing'}
        item['last_seen']=time.monotonic()
        if item['state']=='starting' and time.monotonic()-item['started']>30:item['state']='failed'
        if item['state']=='streaming' and time.monotonic()-item['last_frame']>30:item['state']='failed'
        return {'success':True,'state':item['state'],'error':item.get('last_error','')}

def stop_relay(relay_id):
    relay_id=valid_relay_id(relay_id)
    with RELAY_LOCK: item=RELAYS.pop(relay_id,None)
    if not item:return {'success':True,'state':'stopped'}
    proc=item['process']
    if proc and proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill();proc.wait(timeout=2)
    if item['sdp']:
        try: os.unlink(item['sdp'])
        except FileNotFoundError: pass
    return {'success':True,'state':'stopped'}

OBS = {}
OBS_LOCK = threading.RLock()

def obs_auth(body):
    path=body.get('path','');action=body.get('action','')
    if action=='api':return bool(TOKEN) and hmac.compare_digest(str(body.get('user','')),'ptr-service') and hmac.compare_digest(str(body.get('password','')),TOKEN)
    if body.get('protocol')!='rtmp' or action not in ('publish','read'): return False
    with OBS_LOCK:
        for item in OBS.values():
            if hmac.compare_digest(path,item['path']) and not item['stopped']:
                if action=='publish':
                    publisher_id=str(body.get('id',''))
                    if not re.fullmatch(r'[a-fA-F0-9-]{36}',publisher_id) or len(item['publishers'])>=32:return False
                    item['publishers'].add(publisher_id);return True
                return hmac.compare_digest(str(body.get('user','')),'ptr') and hmac.compare_digest(str(body.get('password','')),item['read_secret'])
    return False

def obs_start(ident,video_port,audio_port,destination=None):
    ident=valid_relay_id(ident)
    if destination:destination=validate_destination(destination)
    if not all(isinstance(port,int) and 1024<=port<=65534 for port in (video_port,audio_port)) or video_port==audio_port:raise ValueError('Invalid ingest ports')
    host=os.environ.get('JANUS_RTP_HOST','janus')
    mediamtx=os.environ.get('OBS_RTMP_HOST','mediamtx')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}',host) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}',mediamtx):raise ValueError('Invalid ingest configuration')
    with OBS_LOCK:
        if ident in OBS:raise ValueError('Ingest already exists')
        item={'path':'live/'+secrets.token_urlsafe(32),'read_secret':secrets.token_urlsafe(32),'state':'waiting','stopped':False,'process':None,'last_error':'','last_seen':time.monotonic(),'publishers':set()}
        OBS[ident]=item
    def worker():
        while True:
            with OBS_LOCK:
                if item['stopped']:return
                read_url='rtmp://%s:1935/%s?user=ptr&pass=%s' % (mediamtx,item['path'],item['read_secret'])
            args=['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-analyzeduration','1000000','-probesize','32768','-i',read_url,'-map','0:v:0','-c:v','libvpx','-deadline','realtime','-f','rtp','-payload_type','96','rtp://%s:%d' % (host,video_port),'-map','0:a:0','-c:a','libopus','-ar','48000','-ac','2','-f','rtp','-payload_type','111','-progress','pipe:1','rtp://%s:%d' % (host,audio_port)]
            if destination:args += ['-map','0:v:0','-map','0:a:0','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-f','flv',destination]
            try:proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
            except OSError:
                with OBS_LOCK:item['state']='failed'
                return
            with OBS_LOCK:
                if item['stopped']:proc.terminate();proc.wait();return
                item['process']=proc
            threading.Thread(target=collect_safe_errors,args=(proc,item,OBS_LOCK),daemon=True).start()
            try:
                for line in proc.stdout:
                    if line.startswith('frame=') and int(line.partition('=')[2].strip() or '0')>0:
                        with OBS_LOCK:item.update(state='streaming',last_error='')
            except (ValueError,OSError):pass
            proc.wait()
            with OBS_LOCK:
                item['process']=None
                if item['stopped']:return
                item['state']='waiting'
            time.sleep(1)
    threading.Thread(target=worker,daemon=True).start()
    return {'success':True,'state':'waiting','publishPath':item['path']}

def obs_status(ident):
    ident=valid_relay_id(ident)
    with OBS_LOCK:
        item=OBS.get(ident)
        if item:item['last_seen']=time.monotonic()
        return {'success':bool(item),'state':item['state'] if item else 'missing','error':item.get('last_error','') if item else ''}

def obs_stop(ident):
    ident=valid_relay_id(ident)
    with OBS_LOCK:
        item=OBS.get(ident)
        if not item:return {'success':True,'state':'stopped'}
        item['stopped']=True;item['state']='stopping';proc=item['process'];publishers=list(item['publishers'])
    if proc and proc.poll() is None:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=2)
    host=os.environ.get('OBS_RTMP_HOST','mediamtx')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}',host):raise ValueError('Invalid ingest configuration')
    credentials=base64.b64encode(('ptr-service:'+TOKEN).encode()).decode()
    for publisher in publishers:
        request=urllib.request.Request('http://%s:9997/v3/rtmp/conns/kick/%s' % (host,publisher),method='POST',headers={'Authorization':'Basic '+credentials})
        try:
            with urllib.request.urlopen(request,timeout=5) as response:
                if response.status not in (200,204):raise ValueError('Could not terminate OBS publisher')
        except urllib.error.HTTPError as error:
            if error.code!=404:raise ValueError('Could not terminate OBS publisher') from None
        except (OSError,ValueError):raise ValueError('Could not terminate OBS publisher') from None
    with OBS_LOCK:OBS.pop(ident,None)
    return {'success':True,'state':'stopped'}

def reap_orphaned_streams():
    while True:
        time.sleep(10);now=time.monotonic()
        with RELAY_LOCK: old_relays=[ident for ident,item in RELAYS.items() if now-item['last_seen']>60]
        with OBS_LOCK: old_obs=[ident for ident,item in OBS.items() if now-item['last_seen']>60]
        for ident in old_relays:
            try:stop_relay(ident)
            except (OSError,ValueError,subprocess.TimeoutExpired):pass
        for ident in old_obs:
            try:obs_stop(ident)
            except (OSError,ValueError,subprocess.TimeoutExpired):pass
threading.Thread(target=reap_orphaned_streams,daemon=True).start()

class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.reply(200 if self.path == '/health' else 404, {'ok': self.path == '/health'})

    def do_POST(self):
        if self.path == '/obs/auth':
            try:
                size=int(self.headers.get('Content-Length','0'))
                if size<1 or size>4096:raise ValueError('Invalid auth request')
                allowed=obs_auth(json.loads(self.rfile.read(size)))
            except (ValueError,OSError):allowed=False
            return self.reply(200 if allowed else 403,{'success':allowed})
        if not TOKEN or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
            return self.reply(401, {'success': False, 'message': 'Unauthorized'})
        if self.path not in ('/process','/relay/reserve','/relay/start','/relay/status','/relay/stop','/obs/start','/obs/status','/obs/stop'):
            return self.reply(404, {'success': False})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 1 or size > 4096:
                raise ValueError('Invalid request size')
            body = json.loads(self.rfile.read(size))
            if self.path.startswith('/obs/'):
                action=self.path.rsplit('/',1)[-1];ident=body.get('id')
                result={'start':lambda:obs_start(ident,body.get('videoPort'),body.get('audioPort'),body.get('destination')),'status':lambda:obs_status(ident),'stop':lambda:obs_stop(ident)}[action]()
                return self.reply(200,result)
            if self.path.startswith('/relay/'):
                action=self.path.rsplit('/',1)[-1];ident=body.get('id')
                result={'reserve':lambda:reserve_relay(ident),'start':lambda:start_relay(ident,body.get('destination')),'status':lambda:relay_status(ident),'stop':lambda:stop_relay(ident)}[action]()
                return self.reply(200,result)
            if not LOCK.acquire(timeout=1800):
                return self.reply(503, {'success': False, 'message': 'Recording processing is busy. Please retry.'})
            try:
                result = process(body.get('id'))
            finally:
                LOCK.release()
            self.reply(200, result)
        except (ValueError, OSError, subprocess.TimeoutExpired) as error:
            self.reply(422, {'success': False, 'message': str(error)})

    def log_message(self, format, *args):
        if self.path == '/obs/auth':return
        print('media-processor:', format % args, flush=True)

if __name__ == '__main__':
    if not TOKEN:
        raise SystemExit('MEDIA_PROCESSOR_TOKEN is required')
    ThreadingHTTPServer(('0.0.0.0', 8090), Handler).serve_forever()
