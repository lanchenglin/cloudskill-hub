import {mountUsageGuide} from './lib/usage-ui.js';
const guide=mountUsageGuide(document.getElementById('publicUsageGuide'),{origin:location.origin});
// Only public project/skill IDs may prefill this page; never accept origin or credential parameters.
const params=new URLSearchParams(location.search),project=params.get('project'),slug=params.get('skill');
if([project,slug].every(s=>typeof s==='string'&&s.length<=64&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)))guide.selectSkill({project,slug,visibility:'public'});
fetch('/api/public/catalog',{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)})
 .then(async response=>{if(!response.ok)throw Error('Unavailable');guide.setSkills((await response.json()).skills);})
 .catch(()=>{document.getElementById('guidePublicStatus').textContent='共享技能候选暂时无法读取，说明仍可使用；可以手动填写 ID 或让 AI 查询。';});
