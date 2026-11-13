"""Local-only FFmpeg RTP -> RTMP integration; no external services are contacted."""
import importlib.util, os, socket, subprocess, tempfile, time, uuid
from pathlib import Path
spec=importlib.util.spec_from_file_location('processor',Path(__file__).resolve().parent.parent/'docker/media-processor.py')
processor=importlib.util.module_from_spec(spec);spec.loader.exec_module(processor)
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close();os.environ['STREAM_LOCAL_ALLOWLIST']=f'127.0.0.1:{port}'
relay_id=str(uuid.uuid4());temp=tempfile.TemporaryDirectory();output=str(Path(temp.name)/'sink.flv');sink=video=audio=None
try:
 sink=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-listen','1','-i',f'rtmp://127.0.0.1:{port}/live/test','-c','copy','-f','flv',output],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 time.sleep(.5);reservation=processor.reserve_relay(relay_id);processor.start_relay(relay_id,f'rtmp://127.0.0.1:{port}/live/test')
 video=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-re','-f','lavfi','-i','testsrc=size=320x180:rate=10','-c:v','libvpx','-g','10','-deadline','realtime','-f','rtp','-payload_type','96',f'rtp://127.0.0.1:{reservation["videoPort"]}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 audio=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-re','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-c:a','libopus','-ac','2','-f','rtp','-payload_type','111',f'rtp://127.0.0.1:{reservation["audioPort"]}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 end=time.time()+25
 while time.time()<end and processor.relay_status(relay_id)['state'] not in ('streaming','failed'):time.sleep(.2)
 status=processor.relay_status(relay_id)['state'];print('relay:',status,flush=True)
 if status!='streaming':raise RuntimeError('No media reached the local RTMP sink')
 time.sleep(2);processor.stop_relay(relay_id);sink.wait(timeout=5)
 probe=subprocess.run(['ffprobe','-v','error','-show_entries','stream=codec_type','-of','csv=p=0',output],capture_output=True,text=True,check=True).stdout
 if 'video' not in probe or 'audio' not in probe:raise RuntimeError('Local output is missing audio/video')
 print('local RTMP sink received audio and video',flush=True)
finally:
 try:processor.stop_relay(relay_id)
 except Exception:pass
 for proc in [video,audio,sink]:
  if proc and proc.poll() is None:
   proc.terminate()
   try:proc.wait(timeout=3)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()
 temp.cleanup()
