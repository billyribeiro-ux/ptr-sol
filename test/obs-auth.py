"""Pure sidecar auth/lifecycle checks; no external networks are used."""
import importlib.util
import time
import os
os.environ['MEDIA_PROCESSOR_TOKEN']='local-test-token'
from pathlib import Path
spec=importlib.util.spec_from_file_location('processor',Path(__file__).resolve().parent.parent/'docker/media-processor.py')
processor=importlib.util.module_from_spec(spec);spec.loader.exec_module(processor)
ident='8d75fb52-7916-4fb3-b7b5-96891ee658b6'
processor.OBS[ident]={'path':'live/temporary-publish-secret','read_secret':'temporary-read-secret','state':'waiting','stopped':False,'process':None,'last_seen':time.monotonic(),'publishers':set()}
assert processor.obs_auth({'protocol':'rtmp','action':'publish','path':'live/temporary-publish-secret','id':'30343663-b708-4387-b760-849dd863c008'})
assert not processor.obs_auth({'protocol':'rtmp','action':'publish','path':'live/wrong'})
assert not processor.obs_auth({'protocol':'rtmp','action':'read','path':'live/temporary-publish-secret','user':'ptr','password':'wrong'})
assert processor.obs_auth({'protocol':'rtmp','action':'read','path':'live/temporary-publish-secret','user':'ptr','password':'temporary-read-secret'})
assert not processor.obs_auth({'protocol':'http','action':'publish','path':'live/temporary-publish-secret','id':'30343663-b708-4387-b760-849dd863c008'})
assert processor.obs_auth({'action':'api','user':'ptr-service','password':'local-test-token'})
assert not processor.obs_auth({'action':'api','user':'ptr-service','password':'wrong'})
class Response:
    status=200
    def __enter__(self):return self
    def __exit__(self,*args):pass
requests=[]
processor.urllib.request.urlopen=lambda request,timeout: (requests.append(request) or Response())
processor.obs_stop(ident)
assert len(requests)==1 and requests[0].full_url.endswith('/30343663-b708-4387-b760-849dd863c008')
assert not processor.obs_auth({'protocol':'rtmp','action':'publish','path':'live/temporary-publish-secret','id':'30343663-b708-4387-b760-849dd863c008'})
print('OBS bearer path and read credential checks passed')
# A failed control API request must retain the stopped entry for retry while
# denying any new publisher, rather than claiming resources were removed.
processor.OBS[ident]={'path':'live/second-publish-secret','read_secret':'another-read-secret','state':'waiting','stopped':False,'process':None,'last_seen':time.monotonic(),'publishers':{'30343663-b708-4387-b760-849dd863c008'}}
def fail_request(*args,**kwargs):raise OSError('offline')
processor.urllib.request.urlopen=fail_request
try:
    processor.obs_stop(ident)
    raise AssertionError('Failed publisher kick was hidden')
except ValueError:pass
assert ident in processor.OBS
assert not processor.obs_auth({'protocol':'rtmp','action':'publish','path':'live/second-publish-secret','id':'30343663-b708-4387-b760-849dd863c008'})
processor.urllib.request.urlopen=lambda request,timeout: Response()
processor.obs_stop(ident)
assert ident not in processor.OBS
print('OBS failed-kick retry checks passed')
