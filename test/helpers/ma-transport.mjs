// Read-only contracts from the installed desktop package. Deliberately fail
// closed when its entry points change; never substitute a permissive router.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";

export function readMaContract(matrixRoot) {
  const file = path.join(matrixRoot, "resources/app.asar"), fd = fs.openSync(file, "r");
  try {
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12)); fs.readSync(fd, header, 0, header.length, 16);
    const tree = JSON.parse(header.toString()), base = 8 + prefix.readUInt32LE(4);
    const read = name => {
      let entry = tree;
      for (const part of name.split("/")) entry = entry?.files?.[part];
      if (!entry || entry.files || entry.unpacked || entry.size > 32 * 1024 * 1024) throw new Error(`MA contract file unavailable: ${name}`);
      const bytes = Buffer.alloc(entry.size); fs.readSync(fd, bytes, 0, bytes.length, base + Number(entry.offset));
      return bytes.toString();
    };
    const pkg = JSON.parse(read("package.json"));
    if (pkg.version !== "1.10.1") throw new Error(`Unverified MA transport: ${pkg.version}`);
    const entry = read("dist-electron/main/index.js").match(/require\("\.\/(index-[^"]+\.js)"\)/u)?.[1];
    if (!entry) throw new Error("MA desktop main entry changed");
    const main = read(`dist-electron/main/${entry}`), preload = read("dist-electron/preload/index.js");
    const rendererFile = `dist${read("dist/index.html").match(/src="\.?(\/assets\/main-[^"?]+\.js)"/u)?.[1]}`;
    const renderer = read(rendererFile);
    const take = (source, start, end) => {
      const at = source.indexOf(start), until = source.indexOf(end, at + start.length);
      if (at < 0 || until < 0) throw new Error(`MA contract changed: ${start}`);
      return source.slice(at, until);
    };
    const filter = vm.runInNewContext(`${take(main, "function shouldForwardNotificationToRenderer(", "function buildOpenClawChatParams(")};shouldForwardNotificationToRenderer`, {}, { timeout: 1000 });
    const protocol = vm.runInNewContext(`(function ${take(main, "handleProtocolEvent(r,n){", "handleNotification(r){")})`,
      { logger$3: { info() {} } }, { timeout: 1000 });
    const maxSeqTrackedRuns=Number(/static MAX_SEQ_TRACKED_RUNS=(\d+)/u.exec(main)?.[1]);
    if(!Number.isSafeInteger(maxSeqTrackedRuns))throw new Error('MA sequence tracking contract changed');
    const trackChatSeq=vm.runInNewContext(`(function ${take(main,'trackChatSeq(r){','handleProtocolEvent(r,n){')})`,
      {logger$3:{info(){},warn(){}},GatewayManager:{MAX_SEQ_TRACKED_RUNS:maxSeqTrackedRuns}},{timeout:1000});
    if (!/auth:\{token:n\},caps:\[\]/u.test(main) || !main.includes('this.rpc("sessions.subscribe",')) throw new Error("MA client capabilities/subscriptions changed");
    for (const channel of ["gateway:notification", "gateway:chat-message", "gateway:session-snapshot"]) {
      if (!preload.includes(`"${channel}"`)) throw new Error(`MA preload excludes ${channel}`);
    }
    const mainHandler = take(main, 'e.on("chat:message",', '),e.on("seq:gap"').slice('e.on("chat:message",'.length);
    const snapshotHandler = take(main, 'e.on("session:snapshot",', '),e.on("welink:outbound-message"').slice('e.on("session:snapshot",'.length);
    const broadcast = take(main, "function isLive(", "const PREPARED_ATTEMPT_TTL_MS=");
    const contract = {
      version: pkg.version, mainFile: `dist-electron/main/${entry}`, rendererFile, renderer,main,
      sha256: { main: createHash("sha256").update(main).digest("hex"),
        renderer: createHash("sha256").update(renderer).digest("hex"),
        preload: createHash("sha256").update(preload).digest("hex") },
      route(event) {
        const delivered = [];
        const window = { isDestroyed: () => false, webContents: { send: (channel, payload) => delivered.push({ channel, payload }) } };
        const handleChat = vm.runInNewContext(`${broadcast};(${mainHandler})`, {
          n: window, a: false, observeEvaluatorTerminal() {}, isWeeklySessionKey: () => false,
          isWorkflowGenSessionKey: () => false, isInternalSessionKey: () => false,
          getAiChatPerformanceCollectorMain: () => ({ recordFirstChatMessageTs() {} }),
        }, { timeout: 1000 });
        const handleSnapshot=vm.runInNewContext(`(${snapshotHandler})`,{n:window,isInternalSessionKey:()=>false},{timeout:1000});
        protocol.call({chatSeqTrack:new Map(),chatSeqEpoch:0,trackChatSeq, emit(kind, payload) {
          if (kind === "chat:message") handleChat(payload);
          else if (kind === "notification" && filter(payload)) window.webContents.send("gateway:notification", payload);
          else if (kind === "session:snapshot") handleSnapshot(payload);
        } }, event.event, event.payload);
        return delivered;
      },
      snapshotClient({sessionKey,now=()=>Date.now(),lastFinalAt}={}){
        if(!renderer.includes('const l=new Map,d=5e3;window.electron.ipcRenderer.on("gateway:chat-message"'))throw new Error('MA snapshot deduplication contract changed');
        const source=take(renderer,'window.electron.ipcRenderer.on("gateway:session-snapshot",','),window.electron.ipcRenderer.on("gateway:agent-state"')
          .slice('window.electron.ipcRenderer.on("gateway:session-snapshot",'.length);
        const events=[],warnings=[],lastFinals=new Map(lastFinalAt===undefined?[]:[[sessionKey,lastFinalAt]]);
        const state={currentSessionKey:sessionKey,handleChatEvent:event=>events.push(event)};
        const isUuidSession=vm.runInNewContext(`${take(renderer,'function Ke(','const Z4=')};Ke`,{},{timeout:1000});
        const receive=vm.runInNewContext(`(${source})`,{Date:{now},console:{log(){},warn:(...args)=>warnings.push(args)},
          Qe:value=>value&&typeof value==='object'?value:undefined,Ie:value=>typeof value==='string'?value:undefined,
          Ke:isUuidSession,Qo:()=>null,Kf:value=>['gateway','ipc','renderer'].includes(value)?value:undefined,
          re:{getState:()=>state},X:{getState:()=>({getMeta:()=>({status:'done'})})},
          l:lastFinals,d:5000,vc:{handleGatewayEvent(){}},Ec(){}},{timeout:1000});
        return {events,warnings,receive};
      },
      // Pure-code regression: real renderer timer and tool branch; stubs only
      // provide the stores/UI utilities normally supplied by the full app.
      progressClient({ setTimeout, clearTimeout, now }) {
        const stores = new Map(), timeouts = [], state = { currentSessionKey: "agent:main:alignment", messages: [],
          streamingTools: [], streamingOrderedBlocks: [] };
        const store = key => { if (!stores.has(key)) stores.set(key, {}); return stores.get(key); };
        const sandbox = {
          Date: { now }, setTimeout, clearTimeout, EB: 300000, jo: new Set(),
          Ae: store, Ce: key => stores.get(key), br: key => store(key).eventSeq ?? 0,
          zo: key => clearTimeout(store(key).responseTimeoutTimer), pU: key => timeouts.push(key),
          X: { getState: () => ({ getMeta: () => ({ status: "delta" }) }) },
          i: () => state, n: update => Object.assign(state, update), Ho: () => undefined,
          Wt: () => ({ getCurrentRound: () => null }),
          $n: (old, next) => [...old.filter(item => !next.some(value => value.id === item.id)), ...next],
          zp: views => views, er() {}, tr() {}, gr: () => [],
        };
        const timer = take(renderer, "function Zi(", "async function pU(");
        const begin = renderer.indexOf("handleChatEvent:async a=>") + "handleChatEvent:async a=>".length;
        const end = renderer.indexOf("const x=Op(", begin);
        if (begin < 30 || end < begin) throw new Error("MA renderer tool handler changed");
        const handle = vm.runInNewContext(`${timer};(async a=>${renderer.slice(begin, end)}})`, sandbox, { timeout: 1000 });
        return { state, timeouts, start: key => vm.runInNewContext(`${timer};Zi(${JSON.stringify(key)})`, sandbox),
          async receive(event) { for (const item of contract.route(event)) if (item.channel === "gateway:chat-message") await handle(item.payload.message); } };
      },
    };
    return contract;
  } finally { fs.closeSync(fd); }
}
