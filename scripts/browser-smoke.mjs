#!/usr/bin/env node
/**
 * Optional offline browser integration smoke test. Uses a fake camera and a
 * synthetic HTTPS meeting page, not a real meeting or physical hardware.
 *
 * CHROME_BIN=/path/to/chromium npm run test:browser
 * Requires Node 22+, OpenSSL, and a Chromium/Chrome build that loads MV3
 * extensions in headless mode. For isolated containers without a usable
 * Chromium sandbox, explicitly opt in with SNAP_TEST_NO_SANDBOX=1; never use
 * that option with a normal browser profile. No existing profile is touched.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.resolve(process.env.SNAP_EXTENSION_DIR || path.join(root, "extension"));
const chromeBin = process.env.CHROME_BIN;
if (!chromeBin || !fs.existsSync(chromeBin)) {
  console.error("Set CHROME_BIN to a local Chrome/Chromium executable before running test:browser.");
  process.exit(1);
}
if (typeof WebSocket === "undefined") {
  console.error("test:browser requires Node.js 22+ (built-in WebSocket).");
  process.exit(1);
}
if (!fs.existsSync(path.join(extension, "manifest.json"))) {
  console.error(`Extension not found at ${extension}. Run npm run build:extension first.`);
  process.exit(1);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "snap-vanish-browser-"));
let browser;
let server;
let socket;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(fn, description, timeout = 30_000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}: ${String(last)}`);
}

try {
  const key = path.join(temp, "key.pem");
  const cert = path.join(temp, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=meet.google.com"], { stdio: "ignore" });
  server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html",
      "content-security-policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:",
    });
    res.end("<!doctype html><html><head><title>Offline meeting fixture</title></head><body></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const profile = path.join(temp, "profile");
  const args = [
    "--headless=new", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking",
    "--no-proxy-server", "--ignore-certificate-errors", "--no-first-run", "--no-default-browser-check",
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    "--host-resolver-rules=MAP meet.google.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost",
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
  ];
  if (process.env.SNAP_TEST_NO_SANDBOX === "1") {
    console.warn("Warning: Chromium sandbox disabled for this temporary test profile.");
    args.unshift("--no-sandbox");
  }
  browser = spawn(chromeBin, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  browser.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let exitCode = null;
  let spawnError = null;
  browser.on("error", (error) => { spawnError = error; });
  browser.on("exit", (code) => { exitCode = code ?? -1; });
  const portFile = path.join(profile, "DevToolsActivePort");
  await eventually(() => {
    if (spawnError) throw spawnError;
    if (exitCode !== null) throw new Error(`Browser exited ${exitCode}: ${stderr.slice(-2000)}`);
    return fs.existsSync(portFile);
  }, "Chrome debugging port", 15_000);
  const [debugPort, browserPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  socket = new WebSocket(`ws://127.0.0.1:${debugPort}${browserPath}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`DevTools timed out: ${method}`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async function evaluate(session, expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  const worker = await eventually(async () => (await send("Target.getTargets")).targetInfos
    .find((target) => target.type === "service_worker" && target.url.endsWith("/background.js")), "extension service worker");
  const workerSession = (await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).sessionId;
  async function openPage(name) {
    const target = (await send("Target.createTarget", { url: `https://meet.google.com:${port}/${name}` })).targetId;
    const session = (await send("Target.attachToTarget", { targetId: target, flatten: true })).sessionId;
    await send("Target.activateTarget", { targetId: target });
    await eventually(() => evaluate(session, "document.readyState === 'complete'"), `${name} page`);
    // Give document_idle content scripts time to register.
    await sleep(500);
    return { target, session };
  }
  async function sendToPage(name, message) {
    return evaluate(workerSession, `(async()=>{const tabs=await chrome.tabs.query({url:'https://meet.google.com/*'});` +
      `const tab=tabs.find(t=>t.url.endsWith(${JSON.stringify(`/${name}`)}));` +
      `return chrome.tabs.sendMessage(tab.id,${JSON.stringify(message)});})()`);
  }

  const page = await openPage("fixture");
  await eventually(async () => (await sendToPage("fixture", { type: "SETTINGS", payload: {
    gesture: { detectionMode: "gesture-only" }, sound: false, muteOnVanish: false, pauseWhenHidden: false, duration: 0.4,
  } }))?.ok, "content script");
  const fixture = await evaluate(page.session, `(async()=>{
    const camera=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
    const source=document.createElement('canvas');source.width=320;source.height=180;
    source.getContext('2d').fillRect(0,0,320,180);
    const screen=source.captureStream(10);
    const self=document.createElement('video');self.muted=true;self.autoplay=true;self.srcObject=camera;
    self.style.cssText='display:block;width:640px;height:360px';document.body.append(self);await self.play();
    const pc=new RTCPeerConnection();const cameraSender=pc.addTrack(camera.getVideoTracks()[0],camera);
    const screenSender=pc.addTrack(screen.getVideoTracks()[0],screen);
    window.fixture={camera,self,screen,pc,cameraSender,screenSender,original:cameraSender.track,screenOriginal:screenSender.track};
    return {width:self.videoWidth,height:self.videoHeight};})()`);
  assert(fixture.width > 64 && fixture.height > 64, "Fake camera did not start");
  // Headless Chromium may otherwise leave a newly created target backgrounded,
  // which suppresses video-frame callbacks regardless of extension settings.
  await send("Target.activateTarget", { targetId: page.target });
  await send("Page.bringToFront", {}, page.session);
  await eventually(() => evaluate(page.session, "!document.hidden"), "visible meeting fixture");
  let lastModelState;
  const model = await eventually(async () => {
    lastModelState = await sendToPage("fixture", { type: "GET_STATE" });
    return lastModelState.handModelBackend === "offscreen" && lastModelState.detectionActive ? lastModelState : false;
  }, "active extension-origin inference under restrictive CSP", 45_000).catch((error) => {
    throw new Error(`${error.message}; last state: ${JSON.stringify(lastModelState)}`);
  });
  assert.equal(model.audioGateActive, false, "Gesture-only unexpectedly opened microphone");
  const before = await evaluate(workerSession, "chrome.runtime.sendMessage({type:'OFFSCREEN_STATUS'})");
  assert.equal(before.handModelCount, 1);
  await sendToPage("fixture", { type: "SETTINGS", payload: { gesture: { detectionMode: "manual" } } });
  await eventually(async () => (await evaluate(workerSession, "chrome.runtime.sendMessage({type:'OFFSCREEN_STATUS'})")).handModelCount === 0, "offscreen model release");
  console.log("✓ Restrictive CSP: real local inference and model release");

  const start = await sendToPage("fixture", { type: "SNAP_VANISH_NOW" });
  assert.equal(start.ok, true, JSON.stringify(start));
  await eventually(() => evaluate(page.session, "fixture.cameraSender.track!==fixture.original"), "camera sender replacement");
  await eventually(async () => (await sendToPage("fixture", { type: "GET_STATE" })).engineState === "vanished", "vanish completion");
  const output = await evaluate(page.session, `(async()=>{
    const canvas=document.getElementById('snap-vanish-rtc-canvas');
    const pixel=[...canvas.getContext('2d').getImageData(10,10,1,1).data];
    const v=document.createElement('video');v.muted=true;v.srcObject=new MediaStream([fixture.cameraSender.track]);
    await v.play();await new Promise(r=>setTimeout(r,250));
    const copy=document.createElement('canvas');copy.width=v.videoWidth;copy.height=v.videoHeight;
    copy.getContext('2d').drawImage(v,0,0);const outgoing=[...copy.getContext('2d').getImageData(10,10,1,1).data];v.srcObject=null;
    return {pixel,outgoing,width:canvas.width,height:canvas.height,trackWidth:copy.width,trackHeight:copy.height,
      screenUnchanged:fixture.screenSender.track===fixture.screenOriginal};})()`);
  assert.deepEqual(output.pixel, [14, 16, 22, 255]);
  assert(output.outgoing.slice(0, 3).every((value, i) => Math.abs(value - [14, 16, 22][i]) < 6));
  assert.deepEqual([output.width, output.height, output.trackWidth, output.trackHeight],
    [fixture.width, fixture.height, fixture.width, fixture.height]);
  assert(output.screenUnchanged, "Screen-share sender was replaced");
  assert.equal((await sendToPage("fixture", { type: "EMERGENCY_RESTORE" })).ok, true);
  assert(await evaluate(page.session, "fixture.cameraSender.track===fixture.original && fixture.screenSender.track===fixture.screenOriginal"));
  console.log("✓ Outgoing pixels, camera restoration, and screen-share isolation");

  const local = await openPage("overlay");
  await eventually(async () => (await sendToPage("overlay", { type: "SETTINGS", payload: {
    gesture: { detectionMode: "manual" }, sound: false, muteOnVanish: false, pauseWhenHidden: false, duration: 0.4,
  } }))?.ok, "overlay content script");
  await evaluate(local.session, `(async()=>{const stream=await navigator.mediaDevices.getUserMedia({video:true});
    const video=document.createElement('video');video.muted=true;video.autoplay=true;
    video.style.cssText='display:block;width:640px;height:360px';video.srcObject=stream;document.body.append(video);
    await video.play();window.fixtureStream=stream;return true;})()`);
  assert.equal((await sendToPage("overlay", { type: "SNAP_VANISH_NOW" })).ok, true);
  await eventually(async () => (await sendToPage("overlay", { type: "GET_STATE" })).engineState === "vanished", "local-only vanish");
  await send("DOM.enable", {}, local.session);
  const document = await send("DOM.getFlattenedDocument", { depth: -1, pierce: true }, local.session);
  const node = document.nodes.find((item) => item.nodeName === "CANVAS" && item.attributes?.includes("tile-canvas"));
  assert(node, "Closed-shadow local overlay not found");
  const object = (await send("DOM.resolveNode", { nodeId: node.nodeId }, local.session)).object;
  const result = await send("Runtime.callFunctionOn", { objectId: object.objectId,
    functionDeclaration: "function(){return {display:getComputedStyle(this).display,pixel:[...this.getContext('2d').getImageData(10,10,1,1).data]}}",
    returnByValue: true }, local.session);
  assert.equal(result.result.value.display, "block");
  assert.deepEqual(result.result.value.pixel, [14, 16, 22, 255]);
  const localState = await sendToPage("overlay", { type: "GET_STATE" });
  assert.equal(localState.interceptionMode, "dom-overlay");
  assert.equal(localState.renderError, null);
  console.log("✓ Local-only overlay pixels and truthful mode");
  console.log("Browser smoke passed (synthetic fixture; no real meeting, physical device, or gesture-accuracy claim).");
} catch (error) {
  console.error(`Browser smoke failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => browser.once("exit", resolve)), sleep(2000)]);
    if (browser.exitCode === null) browser.kill("SIGKILL");
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
