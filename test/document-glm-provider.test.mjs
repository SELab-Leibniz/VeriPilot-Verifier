import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeGatewayCodingProvider,createNativeGatewayEvaluation} from '../scripts/helpers/native-gateway-evaluation.mjs';
const flash={api:'openai-completions',baseUrl:'https://open.bigmodel.cn/api/coding/paas/v4',model:'glm-5.3-flash'};
test('document GLM Flash uses its real reasoning capability and lightest valid wire effort',()=>{
 const chosen=nativeGatewayCodingProvider(flash),m=chosen.definition.models[0];
 assert.equal(chosen.providerId,'openai');assert.equal(chosen.model,flash.model);
 assert.equal(m.reasoning,true);assert.equal(m.compat.thinkingFormat,'openai');assert.equal(m.compat.supportsReasoningEffort,true);
 assert.equal(m.thinkingLevelMap.off,'low');assert.equal(m.thinkingLevelMap.low,'low');
 assert.equal(Object.hasOwn(chosen.definition,'apiKey'),false);
 for(const override of [{apiKey:'controlled-dummy'},{baseUrl:'https://example.invalid'},{api:'anthropic-messages'},{model:'unrequested-model'}])assert.throws(()=>nativeGatewayCodingProvider({...flash,...override}),/Unsupported explicit Gateway provider/);
});
test('document authorization cannot weaken the existing metered boundary for other Coding models',async()=>{
 await assert.rejects(createNativeGatewayEvaluation({provider:{...flash,model:'glm-5.3'},providerGuard:{kind:'authorized_native_document'}}),/offline network guard or a metered batch/);
 await assert.rejects(createNativeGatewayEvaluation({provider:flash,providerGuard:{kind:'unlimited'}}),/offline network guard or a metered batch/);
 const old=nativeGatewayCodingProvider({...flash,model:'glm-5.3'}).definition.models[0];
 assert.equal(old.reasoning,false);assert.equal(old.compat.supportsReasoningEffort,false);assert.equal(Object.hasOwn(old,'thinkingLevelMap'),false);
});
