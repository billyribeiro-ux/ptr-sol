#!/usr/bin/env python3
"""Inventory the captured settings and source references, without inferring parity."""
import json, re
from collections import Counter
from pathlib import Path
root=Path(__file__).resolve().parent.parent
capture=root/'contracts/reference/specs'
spec=capture/'02_enterprise_portal_session_management.md'
lines=spec.read_text().splitlines(); template=root/'public/app/views/page.manageSession.html'; tmpl=template.read_text().splitlines()
front=(root/'public/dist/app.min.js').read_text(); original_front=(root/'contracts/reference/app.min.js').read_text(); viewfiles=[p for p in (root/'public/app/views').rglob('*.html') if p!=template]
backend=[p for p in (root/'src').rglob('*.js')]; tests=[p for p in (root/'test').glob('*.js')]
def refs(files,field):
 pattern=re.compile(r'(?<![A-Za-z0-9_])'+re.escape(field)+r'(?![A-Za-z0-9_])')
 out=[]
 for p in files:
  matches=[i for i,line in enumerate(p.read_text(errors='replace').splitlines(),1) if pattern.search(line)]
  if matches: out.append({'file':str(p.relative_to(root)),'lines':matches[:12],**({'additional_matches':len(matches)-12} if len(matches)>12 else {})})
 return out
verified = {
 'darkThemeAsDefault': ('Frontend selects dark as the initial theme only if no room-local user theme is saved.', 'test/frontend.test.js', 'source_assertion_only; browser behavior not independently exercised'),
 'showOnlyUsernames': ('When enabled, the roster renders each nickname without avatar, badges, tagline, or location.', 'test/frontend.test.js', 'render_helper_and_room_session_api_test; full browser behavior not independently exercised'),
 'rosterVisibleToViewers': ('When disabled, the socket roster exposes only the current user to a viewer.', 'test/realtime.test.js', 'targeted_realtime_test'),
 'onlyPresentersVisibleToViewers': ('Socket roster limits visible identities to self and presenters.', 'test/realtime.test.js', 'targeted_realtime_test'),
 'hasTypingIndicator': ('Socket typing indicators honor the setting.', 'test/realtime.test.js', 'targeted_realtime_test'),
 'allowUsersToChangeUsername': ('Socket nick-change authorization honors the setting.', 'test/realtime.test.js', 'targeted_realtime_test'),
 'fileAccessCaseByCase': ('Room file access checks membership flags when enabled.', 'test/rest.test.js', 'targeted_rest_test'),
 'userUploads': ('Participants may upload images only when enabled and authorized.', 'test/images.test.js', 'targeted_api_test'),
 'autoOpenTime': ('Scheduled room opening uses validated Eastern time.', 'test/realtime.test.js', 'targeted_schedule_test'),
 'autoCloseTime': ('Scheduled room closing uses validated Eastern time.', 'test/realtime.test.js', 'targeted_schedule_test'),
 'ignoreAutoOpenCloseOnWeekend': ('Scheduler skips weekends when enabled.', 'test/realtime.test.js', 'targeted_schedule_test'),
 'login_webhook_url': ('Authenticated joins enqueue configured, allowlisted webhooks.', 'test/webhooks.test.js', 'targeted_service_test'),
 'logout_webhook_url': ('Authenticated departures enqueue configured, allowlisted webhooks.', 'test/webhooks.test.js', 'targeted_service_test'),
}
settings=[]
for n,line in enumerate(lines,1):
 m=re.match(r'^\|\s*(\d+)\s*\|\s*\*\*(.*?)\*\*\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*(.*?)\s*\|',line)
 if not m:continue
 number=int(m[1]); captured=m[3].strip().strip('`'); field=captured.removeprefix('sess.') if captured.startswith('sess.') else None
 if number==15:field='logout_webhook_url' # verified editor binding fix
 item={'number':number,'label':m[2], 'captured_property':captured if captured!='-' else None,'current_property':'sess.'+field if field else None,'input_type':m[4].strip().strip('`'),'scope':m[5].strip().strip('`'),'capture_spec':{'file':'contracts/reference/specs/02_enterprise_portal_session_management.md','line':n}}
 if number==15:item['correction']='Captured binding accidentally used login_webhook_url; current editor uses logout_webhook_url.'
 if not field:
  item.update({'status':'control_without_property','evidence':{},'test_status':'not_assessed_for_this_control'});settings.append(item);continue
 pat=re.compile(r'(?<![A-Za-z0-9_])'+re.escape(field)+r'(?![A-Za-z0-9_])')
 loc=[i for i,t in enumerate(tmpl,1) if pat.search(t)]
 vr=refs(viewfiles,field);br=refs(backend,field);tr=refs(tests,field)
 # Count runtime field reads, not merely management UI labels.
 runtime_patterns=[r'(?:sessData|pubSessionData|globals|roomState)\.'+re.escape(field)+r'\b',r'\$scope\.sess\.'+re.escape(field)+r'\b']
 runtime=sum(len(re.findall(x,front)) for x in runtime_patterns)
 original_runtime=sum(len(re.findall(x,original_front)) for x in runtime_patterns)
 captured_runtime=sum(len(re.findall(x,original_front)) for x in runtime_patterns[:1])
 item['captured_desktop_runtime_evidence'] = 'direct_room_state_read' if captured_runtime else ('referenced_in_non_management_view' if vr else 'not_detected_by_static_scan')
 if field in ('useV5','useV4','useV3'):
  item['capture_context']='Legacy/version-integration control; V5 report describes separate mobile ecosystem, not proof of active desktop behavior.'
 item['evidence']={'management_template':{'file':'public/app/views/page.manageSession.html','lines':loc[:20]},'frontend_runtime_read_count':runtime,'captured_desktop_runtime_read_count':original_runtime,'other_view_references':vr,'backend_source_references':br,'test_source_references':tr}
 item['storage']='Owner save/reload exercised with one representative value in test/frontend.test.js; persistence does not demonstrate runtime effect.'
 if field=='chatServerURL': item['storage']='Save accepts value but room serializer always returns /talk; configured external URL has no effect.'
 item['status']='runtime_reference_requires_behavior_review' if runtime or vr or br else 'generic_storage_only_no_runtime_reference_found'
 item['test_status']='test_source_mentions_property_not_proof_of_behavior' if tr else 'no_property_named_test_found'
 if field in verified:
  behavior,testfile,teststatus=verified[field]
  item['observed_behavior']=behavior;item['targeted_test']={'file':testfile,'status':teststatus}
 settings.append(item)
assert len(settings)==268 and [s['number'] for s in settings]==list(range(1,269))
routes=[]
routesource=(capture/'43_config_routesConfig.js').read_text()
for m in re.finditer(r'\.state\("([^"]+)",\{([\s\S]*?)(?=\}\)\s*\.state\(|\}\),\$urlRouterProvider)',routesource):
 name,body=m.groups(); url=re.search(r'url:"([^"]+)"',body);view=re.search(r'Route\.base\("([^"]+)"\)',body)
 filename=view.group(1) if view else None
 routes.append({'state':name,'url_fragment':url.group(1) if url else None,'template':f'public/app/views/{filename}' if filename else None,'template_present':(root/'public/app/views'/filename).is_file() if filename else None,'status':'template_present_behavior_unverified' if filename else 'routing_only_behavior_unverified'})
result={'provenance':{'capture_origin':'Original capture from protradingroom.com; recorded in the original capture manifest.','settings_spec':'contracts/reference/specs/02_enterprise_portal_session_management.md','current_management_template':'public/app/views/page.manageSession.html','generated_by':'scripts/build-settings-parity.py'},'interpretation':['This is a static source inventory, not a 268-setting parity certification.','References are evidence of names, not proof that a setting affects runtime behavior or that a test covers it.','Manually verify current UI, API, persistence, authorization, live effects, and external providers before declaring parity.','Local provider-dependent, vestigial, and unsupported features remain unverified unless separately tested.', 'generic_storage_only_no_runtime_reference_found means this static scan found no matching direct desktop V3 room-state read, other view reference, or local backend symbol. It does not establish that the original backend lacked behavior, that V5 lacked behavior, or that the setting is broken.'],'settings':settings,'routes':routes,'summary':{'settings_rows':len(settings),'classification':dict(Counter(x['status'] for x in settings)),'route_states':len(routes)}}
(root/'contracts/settings-parity.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result['summary'],indent=2))
