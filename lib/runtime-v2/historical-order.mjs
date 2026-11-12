import {sha256} from './utils.mjs';
export const HISTORICAL_ORDER_STATUS='COMPLETED_WITH_HISTORICAL_DEVIATIONS';
export const HISTORICAL_ORDER_SCHEMA={type:'array',maxItems:100,items:{type:'object',additionalProperties:false,
  required:['objectId','requiredFirstEventId','requiredSecondEventId','historicalOnly','reason'],properties:{
    objectId:{type:'string'},requiredFirstEventId:{type:'string'},requiredSecondEventId:{type:'string'},
    historicalOnly:{const:true},reason:{type:'string',minLength:1}}}};

export function successfulHistoricalResult(block) {
  if (block.is_error === true) return false;
  const texts = typeof block.content === 'string' ? [block.content]
    : (block.content ?? []).filter(value => value.type === 'text').map(value => value.text);
  for (const text of texts) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && (value.success === false
        || Number.isInteger(value.exitCode) && value.exitCode !== 0
        || ['error', 'failed', 'aborted', 'timeout'].includes(value.status))) return false;
    } catch { /* The host's tool success flag still applies to plain text. */ }
  }
  return true;
}

// The reviewer supplies meaning; the program binds a proved deviation to two
// successful original actions in the opposite actual order. Missing events or
// a repairable residue never become a historical exemption.
export function historicalOrderProof({proposal,object,row,events}) {
  const first=events.get(proposal.requiredFirstEventId),second=events.get(proposal.requiredSecondEventId);
  if(proposal.historicalOnly!==true||!proposal.reason||row?.judgement!=='DEVIATION'||object?.verificationTarget!=='PROCESS'
    ||!object.originalSource||!first?.successful||!second?.successful||first.ambiguous||second.ambiguous||first.callIndex<=second.callIndex
    ||first.resultIndex<=first.callIndex||second.resultIndex<=second.callIndex)
    throw Object.assign(new Error('Historical order needs a proved process deviation and two successful, inverted original events.'),{code:'HISTORICAL_ORDER_PROOF_INVALID'});
  const source=object.originalSource;
  const eventDigest=sha256([first.callDigest,first.resultDigest,second.callDigest,second.resultDigest]);
  const factDigest=sha256([object.objectId,source,eventDigest]);
  return {kind:'IRREVERSIBLE_ORDER',objectId:object.objectId,source,eventDigest,factDigest,reason:proposal.reason};
}

export function partitionHistoricalDeviations(summary) {
  const candidates=new Map((summary.historicalCandidates??[]).map(x=>[x.objectId,x]));
  const historical=[],actionable=[];
  for(const deviation of summary.deviations??[]) {
    const proof=candidates.get(deviation.objectId);
    if(proof?.kind==='IRREVERSIBLE_ORDER'&&proof.factDigest)historical.push({...proof,receiptId:deviation.receiptId});
    else actionable.push(deviation);
  }
  const terminal=historical.length>0&&!actionable.length&&summary.status==='DEVIATION'&&summary.complete===true&&!summary.historicalUnverifiedCount;
  return {historical,actionable,status:terminal?HISTORICAL_ORDER_STATUS:summary.status};
}
