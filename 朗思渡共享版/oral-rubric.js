// Source: the owner's 英语口语综合评分标准（100分制）, October 2026 V1.0.
// Never replace an unavailable acoustic dimension with a text score or zero.
const dimensions=Object.freeze([
  {key:'pronunciation',label:'发音准确度',max:20},
  {key:'prosody',label:'重音与语调',max:10},
  {key:'pace',label:'语速',max:10},
  {key:'fluency',label:'停顿与流利度',max:15},
  {key:'intelligibility',label:'可理解度',max:15},
  {key:'grammar',label:'语法准确性',max:10},
  {key:'vocabulary',label:'词汇运用',max:10},
  {key:'content',label:'内容完成度',max:10}
]);
const TEXT_WEIGHTS=Object.freeze({grammar:.35,vocabulary:.30,topicRelevance:.35});
const rounded=n=>Math.round(n*10)/10;
function level(score){return score>=90?'A+':score>=80?'A':score>=70?'B':score>=60?'C':score>=40?'D':'E';}
function finiteScore(value){return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?value:null;}
function readingPace(wpm){
  if(!Number.isFinite(wpm)||wpm<=0)return null;
  // The supplied rubric explicitly widens the reading band to 80–170 WPM.
  return wpm>=80&&wpm<=170?9.5:wpm>=171&&wpm<=180?7.5:wpm>=60&&wpm<=200?5.5:wpm>=40&&wpm<=220?3.5:1;
}
function textReport(evaluation){
  const map={grammar:'grammar',vocabulary:'vocabulary',content:'topicRelevance'};
  const dimensionScores=Object.entries(map).map(([key,field])=>({key,label:dimensions.find(d=>d.key===key).label,max:TEXT_WEIGHTS[field]*100,score:finiteScore(evaluation?.[field])===null?null:rounded(evaluation[field]*TEXT_WEIGHTS[field]),source:'transcript',reason:evaluation?.scoreReasons?.[field]||'请结合实际转写核对。'}));
  const available=dimensionScores.every(d=>d.score!==null);
  const overallScore=available?Math.round(dimensionScores.reduce((s,d)=>s+d.score,0)):null;
  return {mode:'text',status:available?'scored':'unscorable',rubricVersion:'oral-v1',overallScore,level:overallScore===null?null:level(overallScore),dimensionScores,disclaimer:'当前结果基于语音转写文本，不能准确反映真实发音、重音、语调、语速和停顿表现。'};
}
function speechReport(acoustic,evaluation,audioReview=null){
  const raw=acoustic?.scores||{},metrics=acoustic?.metrics||{};
  const rejected=['unscorable','incomplete'].includes(acoustic?.status);
  const scoreMap={pronunciation:finiteScore(raw.accuracy),fluency:finiteScore(raw.fluency),grammar:finiteScore(evaluation?.grammar),vocabulary:finiteScore(evaluation?.vocabulary),content:finiteScore(evaluation?.topicRelevance)};
  const dimensionScores=dimensions.map(d=>{
    let score=null,reason='当前接口未提供可直接对应的可靠指标，待教师评估。',source='unavailable';
    if(!rejected&&scoreMap[d.key]!==undefined&&scoreMap[d.key]!==null){score=rounded(scoreMap[d.key]*d.max/100);source=['grammar','vocabulary','content'].includes(d.key)?'transcript':'xfyun-audio';reason=source==='transcript'?(evaluation?.scoreReasons?.[d.key==='content'?'topicRelevance':d.key]||'根据第二次实际转写分析；请核对识别错误。'):'讯飞百分制指标按本项满分折算，属于待校准的学习反馈。';}
    if(!rejected&&d.key==='pace'&&metrics.wpm!==null&&Number.isFinite(metrics.wpm)){score=readingPace(metrics.wpm);source='word-alignment';reason='按朗读任务参考区间 80–170 WPM 计算，受词对齐和录音边界影响；不是母语口音判定。';}
    const ai=audioReview?.status==='scored'&&audioReview.dimensions?.[d.key];
    if(!rejected&&['prosody','intelligibility'].includes(d.key)&&ai&&Number.isFinite(ai.score)&&ai.score>=0&&ai.score<=d.max&&['high','medium'].includes(ai.confidence)&&ai.evidence?.length){
      return {...d,score:rounded(ai.score),source:'audio-ai-reference',reason:'AI参考评分（未经人工校准）：'+ai.reason,evidence:ai.evidence,confidence:ai.confidence};
    }
    return {...d,score,source,reason};
  });
  const available=dimensionScores.filter(d=>d.score!==null),complete=available.length===dimensions.length;
  const total=complete?Math.round(available.reduce((sum,d)=>sum+d.score,0)):null;
  const priorities=[];
  if(metrics.wpm&&metrics.wpm<80)priorities.push('先按意群练习，再逐渐加快；不要为追求速度牺牲清晰度。');
  if(metrics.wpm>170)priorities.push('适当放慢长句和关键词，先保证每个词清晰可辨。');
  if(acoustic?.words?.some(w=>w.error))priorities.push('先回听标出的词，再听示范并短句跟读；接口误判可手动核对。');
  if(metrics.longPauseCount>0)priorities.push('回听超过两秒的词间间隔，判断是否需要按意群分句；合理停顿不必消除。');
  const aiReference=dimensionScores.some(d=>d.source==='audio-ai-reference');
  return {mode:'speech',status:acoustic?.status||'unscorable',rubricVersion:'oral-v1',coverage:complete?'complete':'partial',overallScore:total,level:total===null?null:level(total),dimensionScores,availablePoints:rounded(available.reduce((s,d)=>s+d.max,0)),subtotal:available.length?rounded(available.reduce((s,d)=>s+d.score,0)):null,metrics,words:acoustic?.words||[],provider:'xfyun-ise',providerScore:finiteScore(raw.total),integrity:finiteScore(raw.integrity),priorities:priorities.slice(0,3),reason:acoustic?.reason||'',aiReference,audioReview:audioReview?{status:audioReview.status,heardTranscript:audioReview.heardTranscript,reason:audioReview.reason}:null,disclaimer:'本次使用真实录音。讯飞朗读分不是本标准的八项综合分；缺少可靠指标的项目显示待评，不按零分处理，也不将部分分数换算成100分。'+(aiReference?'重音语调与可理解度使用百炼直接听录音生成AI参考评分，未经人工校准；综合分也仅供练习参考。':'重音语调与可理解度未完成独立音频评估，仍待评。')+'讯飞接口暂未提供独立英式/美式评测参数；百炼的口音偏好提示不等于专门英美评测认证，英美偏好继续用于示范播放和音标。'};
}
module.exports={dimensions,TEXT_WEIGHTS,readingPace,textReport,speechReport};
