import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "../runtime-v2/utils.mjs";
import { rejectedGroundTruthSource } from "../runtime-v2/ground-truth-provenance.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const baseRef = value => String(value ?? "").trim().replaceAll("\\", "/").replace(/#.*$/u, "").replace(/:\d+(?:-\d+)?$/u, "");
const inferred = new Set(["AGENT_INFERRED", "BASIS_PENDING"]);

// The 4,000-character display is a preview. The actual host message is never
// parsed as another role, summarized, trimmed or cut down for capture.
export async function prepareSourceInputs({ snapshot, sourceCatalog, requestDirectory, projectRoot, previewCharacters = 4000 }) {
  const catalog = clone(sourceCatalog ?? []), sourceTexts = new Map(), sourceFiles = new Map();
  let ordinal = 0;
  const captured = (snapshot?.entries ?? []).flatMap(entry => {
    if (entry.type !== "user" || entry.isMeta === true) return [];
    const content = entry.message?.content;
    const blocks = typeof content === "string" ? [{type:"text",text:content}] : (Array.isArray(content) ? content : []);
    const text = blocks.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
    if (!text.trim()) return [];
    const ids = [entry.uuid, entry.message?.id, entry.entryKey].filter(Boolean);
    const realUsers = catalog.filter(source => source.kind === "USER_MESSAGE");
    let matches = realUsers.filter(source => ids.some(id => source.ref === id || source.ref === `transcript:${id}`));
    if (!matches.length && ids.length) matches = realUsers.filter(source => ids.some(id => !["user","user prompt"].includes(id)
      && (source.aliases ?? []).some(alias => alias === id || alias === `transcript:${id}`)));
    // The existing catalog assigns ordinals only to accepted id-less users.
    if (!text.includes("[runtime-corrector:internal]")) ordinal++;
    if (!ids.length) matches = realUsers.filter(source => source.ref === `transcript:${ordinal}`);
    const identities = [...new Set(matches.map(source => source.ref))];
    return [{text, ref:identities.length === 1 ? identities[0] : null, kind:"USER_MESSAGE"}];
  });
  const directory = path.join(requestDirectory,"user-sources");
  if (captured.length) await fs.mkdir(directory,{recursive:true});
  const userSources = [];
  for (const [index,item] of captured.entries()) {
    const contentHash = sha256(item.text), file = path.join(directory,`${index+1}-${sha256([item.ref,contentHash]).slice(0,24)}.txt`);
    await fs.writeFile(file,item.text,{mode:0o600});
    const canonicalPath = await fs.realpath(file);
    const source = {ref:item.ref,kind:item.kind,path:canonicalPath,characters:item.text.length,sha256:contentHash,complete:true};
    userSources.push(source);
    sourceFiles.set(baseRef(file),source);sourceFiles.set(baseRef(canonicalPath),source);
    sourceTexts.set(baseRef(file),item.text);sourceTexts.set(baseRef(canonicalPath),item.text);
    if(item.ref)sourceTexts.set(item.ref,item.text);
  }
  // Freeze quotes only from the catalog's exact known material/project paths.
  // Reading their bytes does not grant USER_EXPLICIT or create a new catalog.
  for (const source of catalog.filter(source => ["MATERIAL","PROJECT_FILE"].includes(source.kind))) {
    try {
      const file = path.resolve(projectRoot,source.ref), stat = await fs.stat(file);
      if(stat.isFile() && stat.size <= 4*1024*1024) {
        const bytes = await fs.readFile(file);
        if(!bytes.includes(0))sourceTexts.set(source.ref,bytes.toString("utf8"));
      }
    } catch { /* Missing quote bytes never become invented evidence. */ }
  }
  const userMessages = captured.slice(-20).map((item,index) => {
    const source=userSources[captured.length-Math.min(captured.length,20)+index];
    return item.text.slice(0,previewCharacters)+`\n[Display preview only; complete original user message: ${source.path}; catalog ref ${source.ref ?? "unresolved"}; ${source.characters} characters.]`;
  });
  return { userSources,userMessages,sourceDeliveryVersion:1,sourceFiles,sourceTexts,catalog };
}

export function bindSourceSelections(operations, delivery, catalog) {
  const issues=[];
  let firstCode=null;
  function bindOne(operation,index) {
    if(!operation.source)return;
    const source=operation.source;delete source.excerpt;
    const chosen=String(source.ref ?? "").trim().replaceAll("\\","/"), generated=delivery?.sourceFiles.get(baseRef(chosen));
    if(generated) {
      if(!generated.ref)throw Object.assign(new Error("SOURCE_BINDING_INVALID: full user message has no unambiguous catalog identity."),{code:"SOURCE_BINDING_INVALID",sourceBindingIssues:[{index,reason:"SOURCE_NOT_IN_CATALOG"}]});
      source.ref=generated.ref+String(chosen).slice(baseRef(chosen).length);
    }
    // An exact catalog identity such as transcript:1 is not a :line selector.
    if((catalog ?? []).some(entry => [entry.ref,...(entry.aliases ?? [])].includes(source.ref)))return;
    const range=/(?:#L|:)([1-9]\d*)(?:-(?:L)?([1-9]\d*))?$/u.exec(source.ref);
    if(!range)return;
    const selectedBase = source.ref.slice(0,range.index);
    const identities = (catalog ?? []).filter(entry => generated ? entry.ref===generated.ref
      : [entry.ref,...(entry.aliases ?? [])].some(ref => ref===selectedBase));
    if(new Set(identities.map(entry => entry.ref)).size!==1)return;
    const text=delivery?.sourceTexts.get(generated ? baseRef(generated.path) : identities[0].ref);if(text===undefined)return;
    const start=Number(range[1]),end=Number(range[2] ?? start),lines=text.split("\n");
    if(end<start || end>lines.length)throw Object.assign(new Error("SOURCE_REFERENCE_INVALID: selected line range is outside the frozen original source."),{code:"SOURCE_REFERENCE_INVALID",sourceBindingIssues:[{index,reason:"SOURCE_RANGE_INVALID",ref:source.ref}]});
    source.excerpt=lines.slice(start-1,end).join("\n");
  }
  for(const [index,operation] of (operations ?? []).entries()) {
    try {bindOne(operation,index);}catch(error) {if(!error.sourceBindingIssues)throw error;firstCode??=error.code;issues.push(...error.sourceBindingIssues);}
  }
  if(issues.length)throw Object.assign(new Error(`${firstCode}: ${JSON.stringify(issues)}`),{code:firstCode,sourceBindingIssues:issues});
}

export function validateSourceBindings(operations, catalog) {
  if(!catalog)return;
  const identities = new Set(catalog.flatMap(entry => [entry.ref,...(entry.aliases ?? [])]).map(ref => String(ref).trim().replaceAll("\\","/")));
  const issues=(operations ?? []).flatMap((operation,index) => {
    if(inferred.has(operation.authority))return [];
    const ref=String(operation.source?.ref ?? "").trim().replaceAll("\\","/");
    const anchor=ref.indexOf("#"),line=/^(.*):([1-9]\d*)(?:-([1-9]\d*))?$/u.exec(ref);
    const known=identities.has(ref) || (anchor>=0 && identities.has(ref.slice(0,anchor)))
      || (line && identities.has(line[1]));
    if(!known)return [{index,reason:"SOURCE_NOT_IN_CATALOG",ref:operation.source?.ref,authority:operation.authority}];
    // Preserve a true :line selection for the existing gate, whose numeric
    // stripping otherwise confuses it with numeric transcript identities.
    if(!identities.has(ref) && anchor<0 && line) operation.source.ref=`${line[1]}#L${line[2]}${line[3]?`-L${line[3]}`:""}`;
    const reason=rejectedGroundTruthSource(operation,catalog);
    return reason?[{index,reason,ref:operation.source?.ref,authority:operation.authority}]:[];
  });
  if(issues.length)throw Object.assign(new Error(`SOURCE_BINDING_INVALID: ${JSON.stringify({issues,allowedSources:catalog.map(({ref,kind})=>({ref,kind}))})}`),{code:"SOURCE_BINDING_INVALID",sourceBindingIssues:issues});
}

export function authoritativeOperationMeaning(operations) {
  return (operations ?? []).filter(operation => !inferred.has(operation.authority)).map(({source,...meaning}) => sha256(meaning)).sort();
}

export function sourceRepairSchema(schema, count) {
  return {type:"object",additionalProperties:false,required:["sourceRepairs"],properties:{sourceRepairs:{type:"array",minItems:count,maxItems:count,items:{type:"object",additionalProperties:false,required:["index","source"],properties:{
    index:{type:"integer",minimum:0},source:clone(schema.properties.operations.items.properties.source),
    authority:{type:"string",enum:["USER_EXPLICIT","MATERIAL_DERIVED","PROJECT_CONSTRAINT","AGENT_INFERRED","BASIS_PENDING"]}
  }}}}};
}

function exactCatalogEntry(ref,catalog,delivery) {
  const normalized=String(ref ?? "").trim().replaceAll("\\","/"),generated=delivery?.sourceFiles.get(baseRef(normalized));
  const actual=generated?.ref ?? normalized;
  let entries=(catalog ?? []).filter(entry=>[entry.ref,...(entry.aliases ?? [])].includes(actual));
  if(!entries.length) {
    const hash=actual.indexOf("#"),line=/^(.*):[1-9]\d*(?:-[1-9]\d*)?$/u.exec(actual),base=hash>=0?actual.slice(0,hash):line?.[1];
    if(base)entries=(catalog ?? []).filter(entry=>[entry.ref,...(entry.aliases ?? [])].includes(base));
  }
  return new Set(entries.map(entry=>entry.ref)).size===1?entries[0]:null;
}

export function applySourceRepairs(original, repaired, issues, catalog, delivery) {
  const indices=new Set(issues.map(issue=>issue.index)),seen=new Set(),result=clone(original);
  const fail=reason=>{throw Object.assign(new Error(`SOURCE_REPAIR_INVALID: ${reason}`),{code:"SOURCE_REPAIR_INVALID",sourceBindingIssues:issues});};
  if(!Array.isArray(repaired.sourceRepairs))fail("Return sourceRepairs only.");
  for(const repair of repaired.sourceRepairs) {
    if(!Number.isInteger(repair.index)||!indices.has(repair.index)||seen.has(repair.index))fail("Indices must be unique and belong to the reported bad source positions.");
    seen.add(repair.index);const previous=original.operations[repair.index],target=result.operations[repair.index];
    if(!repair.source || typeof repair.source.ref!=="string")fail("Every repair must select a source.");
    const before=exactCatalogEntry(previous.source?.ref,catalog,delivery),after=exactCatalogEntry(repair.source.ref,catalog,delivery);
    if(repair.authority && repair.authority!==previous.authority) {
      const mayCorrect=previous.authority==="USER_EXPLICIT" && repair.authority==="MATERIAL_DERIVED"
        && issues.some(issue=>issue.index===repair.index&&issue.reason==="NON_USER_AUTHORITY")
        && before?.kind==="MATERIAL" && after?.kind==="MATERIAL" && before.ref===after.ref;
      if(!mayCorrect)fail("Authority can only correct an initially rejected USER_EXPLICIT label on the same catalog material to MATERIAL_DERIVED; never infer, lower severity or promote authority.");
      target.authority=repair.authority;
    }
    target.source=clone(repair.source);
    if(before?.kind==="MATERIAL" && after?.kind==="USER_MESSAGE") {
      target.source.supportingRefs=[...new Set([...(previous.source?.supportingRefs ?? []),previous.source.ref])];
    }
  }
  if(seen.size!==indices.size)fail("Every reported bad source index must be repaired.");
  return result;
}
