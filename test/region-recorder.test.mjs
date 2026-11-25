import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecorder } from '../module/lib/recorder.js';
import { normalizeRecords } from '../module/lib/log.js';
import { regionStatsAverage } from '../module/lib/region-stats.js';
const startAt=Date.UTC(2026,10,25);
const obs=(value,at,quality='live')=>({value,observedAtUnixMillis:at,quality});
const world=(id,at)=>obs({regionId:id,name:id},at);
function setup(values={}){
 let revision=0,writes=0,eventRev=0;
 const storage={getSnapshot:async()=>({revision,values:structuredClone(values)}),batch:async({operations})=>{for(const op of operations)values[op.key]=structuredClone(op.value);writes++;return{revision:++revision,values:structuredClone(values)};}};
 const recorder=createRecorder({storage,getPoi:async id=>({poiId:id,name:id}),toKnots:v=>v,toastEnabled:()=>false,onError:e=>{throw e;}});
 return{recorder,values,get writes(){return writes;},event:(kind,at,data)=>recorder.event({kind,occurredAtUnixMillis:at,revision:++eventRev,data}),
 voyage:at=>recorder.voyage({voyageId:'v1',state:'underway',trackingQuality:'tracking',startedAtUnixMillis:startAt,emittedAtUnixMillis:at,distanceTravelled:100,elapsedMillis:at-startAt,lastSailingDays:1}),
 speed:async(id,at,speed,quality='live',day,dayQuality='live',dayAt=at)=>recorder.telemetry({position:obs({x:1,y:1},at,quality),speedKnots:obs(speed,at,quality),sailingDays:obs(day,dayAt,dayQuality)},world(id,at))};
}
async function begin(h){await h.recorder.start({values:h.values});await h.event('voyage.started',startAt,{voyageId:'v1'});await h.voyage(startAt);}
test('첫 해역부터 방문별 통계가 저장되고 입항 이후는 표본에 넣지 않는다',async()=>{
 const h=setup();await begin(h);await h.speed('A',startAt+1000,10);await h.speed('A',startAt+3000,20);await h.speed('B',startAt+4000,8);await h.speed('B',startAt+6000,12);
 await h.event('shore.arrived',startAt+7000,{nearestPoiId:'dest'});await h.speed('B',startAt+8000,99);
 const record=normalizeRecords(h.values.records)[0];assert.deepEqual(record.regions.map(r=>r.regionId),['A','B']);assert.equal(regionStatsAverage(record.regions[0].stats.segments[0]),15);assert.equal(record.regions[1].stats.segments[0].max,12);assert.equal(typeof h.values.records[0].regions[0].stats,'string');
});
test('경계 전 속도와 해역보다 오래된 속도를 새 방문에 넣지 않는다',async()=>{
 const h=setup();await begin(h);await h.speed('A',startAt+1000,10);await h.recorder.region(world('B',startAt+3000));
 await h.recorder.telemetry({position:obs({x:1,y:1},startAt+2000),speedKnots:obs(100,startAt+2000)},world('B',startAt+3000));
 assert.equal(h.recorder.getState().current.regions.at(-1).stats,undefined);await h.speed('B',startAt+4000,12);assert.equal(h.recorder.getState().current.regions.at(-1).stats.segments[0].max,12);
});
test('재시작과 held 판독 사이에는 평균 시간을 이어 붙이지 않는다',async()=>{
 const h=setup();await begin(h);await h.speed('A',startAt+1000,10);await h.speed('A',startAt+2000,20);await h.speed('A',startAt+3000,0,'held');await h.speed('A',startAt+4000,30);await h.speed('A',startAt+17000,40);
 const before=h.recorder.getState().current.regions[0].stats.segments[0];assert.equal(before.durationMs,1000);
 const resumed=setup(structuredClone(h.values));await resumed.recorder.start({values:resumed.values});await resumed.voyage(startAt+18000);await resumed.speed('A',startAt+18000,50);
 const after=resumed.recorder.getState().current.regions[0].stats.segments[0];assert.equal(after.durationMs,1000);assert.equal(after.max,50);
});
test('매 속도 표본마다 저장하지 않고 15초 간격으로 누적한다',async()=>{
 const h=setup();await begin(h);await h.speed('A',startAt+1000,10);const before=h.writes;for(let i=2;i<=15;i++)await h.speed('A',startAt+i*1000,10);assert.equal(h.writes,before);await h.speed('A',startAt+16000,10);assert.equal(h.writes,before+1);
});

test('늦게 온 해역 변경 이벤트로 이미 지난 해역에 되돌아가지 않는다',async()=>{
 const h=setup();await begin(h);await h.speed('A',startAt+1000,10);await h.speed('B',startAt+3000,10);await h.speed('C',startAt+5000,10);
 await h.event('region.changed',startAt+4000,{regionId:'B',name:'B'});await h.speed('C',startAt+6000,10);
 assert.deepEqual(h.recorder.getState().current.regions.map(r=>r.regionId),['A','B','C']);
});

test('해역별 일수는 같은 시각의 live 판독 증가분을 저장한다',async()=>{
 const h=setup();await begin(h);await h.speed('A',startAt+1000,10,'live',7);await h.speed('A',startAt+2000,12,'live',7);await h.speed('A',startAt+3000,14,'live',8);
 await h.event('shore.arrived',startAt+4000,{nearestPoiId:'dest'});
 assert.equal(normalizeRecords(h.values.records)[0].regions[0].stats.segments[0].sailingDays,1);
});
test('해역별 일수는 held·시각 불일치·음수·소수 판독을 합치지 않는다',async()=>{
 for(const [day,quality,offset] of [[10,'held',0],[10,'live',-1],[-1,'live',0],[9.5,'live',0]]){
  const h=setup();await begin(h);await h.speed('A',startAt+1000,10,'live',7);await h.speed('A',startAt+2000,10,'live',day,quality,startAt+2000+offset);await h.speed('A',startAt+3000,10,'live',11);
  assert.equal(h.recorder.getState().current.regions[0].stats.segments[0].sailingDays,null);
 }
});
