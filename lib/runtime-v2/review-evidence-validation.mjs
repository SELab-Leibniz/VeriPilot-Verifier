import path from 'node:path';
import {validateReviewJudgement,validateReviewFile,validateReviewFinding} from './review-result-validation.mjs';

// Shared boundary for legacy/native structured reports. Validation failures
// remain checker issues; unsupported conclusive claims cannot become receipts.
export function validateStructuredReviewEvidence(review,objects,citations,projectRoot,{roleForObject=()=> 'stop-reviewer',findingRole='stop-reviewer'}={}){
 const byId=new Map(objects.map(object=>[object.objectId,object])),issues=[];
 const key=ref=>{const match=/^(.*?)(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(String(ref));
  return match?`${path.resolve(projectRoot,match[1])}\0${match[2]}\0${match[3]??match[2]}`:ref;};
 const selected=(owner,refs=[])=>citations.filter(citation=>citation.usedBy?.includes(owner)&&refs.some(ref=>[
  citation.selection,citation.originalSelection,citation.path&&`${citation.path}#L${citation.start}-L${citation.end??citation.start}`
 ].filter(Boolean).some(value=>key(ref)===key(value))));
 const check=(id,action,fallback)=>{try{return action();}catch(error){issues.push({type:error.code??'REVIEW_ITEM_EVIDENCE_UNAVAILABLE',objectId:id,message:error.message});return fallback(error);}};
 const counts=new Map();for(const row of review.metricObjectJudgements??[])counts.set(row.objectId,(counts.get(row.objectId)??0)+1);
 review.metricObjectJudgements=(review.metricObjectJudgements??[]).map(row=>{
  const object=byId.get(row.objectId);
  if(!object){issues.push({type:'UNKNOWN_OBJECT',objectId:row.objectId,message:'Unassigned metric object'});return null;}
  if(counts.get(row.objectId)>1){issues.push({type:'DUPLICATE_OBJECT',objectId:row.objectId,message:'Duplicate verdicts for one assigned object'});return {...row,judgement:'CHECKER_ERROR',evidence:[]};}
  return check(row.objectId,()=>validateReviewJudgement({row,object,citations:selected(row.objectId,row.evidence),role:roleForObject(row.objectId),classification:review}),
    error=>({...row,judgement:'CHECKER_ERROR',reason:error.message,evidence:[]}));
 }).filter(Boolean).filter((row,index,rows)=>rows.findIndex(other=>other.objectId===row.objectId)===index);
 review.findings=(review.findings??[]).filter(finding=>check(finding.deviationKey,()=>{
  if(!finding.violatedGroundTruthIds?.length)throw new Error('A finding has no frozen evidence owner');
  validateReviewFinding({finding,objects,citations:selected(finding.deviationKey,finding.actualEvidence??finding.evidence),classification:review,role:findingRole});return true;
 },()=>false));
 review.fileAssessments=(review.fileAssessments??[]).map(file=>check(file.path,()=>validateReviewFile({file,citations:selected(file.path,file.evidence)
  .filter(citation=>citation.path&&path.resolve(projectRoot,citation.path)===path.resolve(projectRoot,file.path))}),error=>({...file,status:'UNVERIFIED',reason:error.message,evidence:[]})));
 return issues;
}
