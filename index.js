#!/usr/bin/env node

const http = require("http");
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

const UPLOAD_URL = process.env.UPLOAD_URL || '';      // 节点或订阅自动上传地址,需填写部署Merge-sub项目后的首页地址,例如：https://merge.xxx.com
const PROJECT_URL = process.env.PROJECT_URL || '';    // 需要上传订阅或保活时需填写项目分配的url,例如：https://google.com
const AUTO_ACCESS = process.env.AUTO_ACCESS || false; // false关闭自动保活，true开启,需同时填写PROJECT_URL变量
const FILE_PATH = process.env.FILE_PATH || '.tmp';   // 运行目录,sub节点文件保存目录
const SUB_PATH = process.env.SUB_PATH || 'sub';       // 订阅路径
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;        // http服务订阅端口
const UUID = process.env.UUID || '7d5c90bf-f3c0-49e7-99ee-058d9eb9002b'; // 使用哪吒v1,在不同的平台运行需修改UUID,否则会覆盖
const NEZHA_SERVER = process.env.NEZHA_SERVER || '';        // 哪吒v1填写形式: nz.abc.com:8008  哪吒v0填写形式：nz.abc.com
const NEZHA_PORT = process.env.NEZHA_PORT || '';            // 使用哪吒v1请留空，哪吒v0需填写
const NEZHA_KEY = process.env.NEZHA_KEY || '';              // 哪吒v1的NZ_CLIENT_SECRET或哪吒v0的agent密钥
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || 'cdn.cbcb.kdns.fr';          // 固定隧道域名,留空即启用临时隧道
const ARGO_AUTH = process.env.ARGO_AUTH || 'eyJhIjoiNjIyMDdiNDVhZTA4ZWQ3M2ZlNzkwNWFmOTY1MjBmZjgiLCJ0IjoiMDAyYWJjNmItMmZmNi00NTI3LWIxYmItM2UwZDZlMmRmNzA2IiwicyI6Ik56TTNaVFV5WXpJdFlXTXpNQzAwTm1ZekxUbGtOVEF0WTJGalptVTFNbUUzWW1VMiJ9';              // 固定隧道密钥json或token,留空即启用临时隧道,json获取地址：https://json.zone.id
const ARGO_PORT = process.env.ARGO_PORT || 8001;            // 固定隧道端口,使用token需在cloudflare后台设置和这里一致
const ARGO_PROTOCOL = process.env.ARGO_PROTOCOL || 'quic';  // 隧道协议: quic 多流无队头阻塞吞吐最高(YouTube/下载收益最大); 被墙或UDP受限时改回 http2
const CFIP = process.env.CFIP || 'saas.sin.fan';            // 节点优选域名或优选ip
const CFPORT = process.env.CFPORT || 443;                   // 节点优选域名或优选ip对应的端口
const NAME = process.env.NAME || '';                        // 节点名称

const MAX_ARGO_RETRIES = 8;      // 临时隧道域名提取最大重试次数
const DOWNLOAD_RETRIES = 2;      // 每个文件下载重试次数
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const logErr = (...a) => console.error(new Date().toISOString().slice(11, 19), '[ERR]', ...a);

// 全局兜底：任何未捕获异常只记日志，绝不 crash 整个进程（否则 xray/argo 还在跑但订阅服务挂了）
process.on('uncaughtException', (err) => logErr('uncaughtException:', err && err.message));
process.on('unhandledRejection', (reason) => logErr('unhandledRejection:', reason));

// 创建运行文件夹
if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH, { recursive: true });
  log(`${FILE_PATH} is created`);
} else {
  log(`${FILE_PATH} already exists`);
}

// 生成随机6位字符
function generateRandomName() {
  const characters = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// 全局常量
let subContent = null;
const npmName = generateRandomName();
const webName = generateRandomName();
const botName = generateRandomName();
const phpName = generateRandomName();
const npmPath = path.join(FILE_PATH, npmName);
const phpPath = path.join(FILE_PATH, phpName);
const webPath = path.join(FILE_PATH, webName);
const botPath = path.join(FILE_PATH, botName);
const subPath = path.join(FILE_PATH, 'sub.txt');
const listPath = path.join(FILE_PATH, 'list.txt');
const bootLogPath = path.join(FILE_PATH, 'boot.log');
const configPath = path.join(FILE_PATH, 'config.json');

// 如果订阅器上存在历史运行节点则先删除
async function deleteNodes() {
  try {
    if (!UPLOAD_URL) return;
    if (!fs.existsSync(subPath)) return;
    const fileContent = await fsp.readFile(subPath, 'utf-8').catch(() => null);
    if (!fileContent) return;

    const decoded = Buffer.from(fileContent, 'base64').toString('utf-8');
    const nodes = decoded.split('\n').filter(line =>
      /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line)
    );
    if (nodes.length === 0) return;

    await axios.post(`${UPLOAD_URL}/api/delete-nodes`,
      JSON.stringify({ nodes }),
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    ).catch(() => null);
  } catch (err) {
    // 静默
  }
}

// 清理历史文件
async function cleanupOldFiles() {
  try {
    const files = await fsp.readdir(FILE_PATH);
    await Promise.all(files.map(file => fsp.unlink(path.join(FILE_PATH, file)).catch(() => { })));
  } catch (err) {
    // 静默
  }
}

// 生成xray配置文件
// 性能要点：
// 1. DNS 从 DoH(https+local://8.8.8.8) 改为 UDP + 内置缓存 —— 原来每个新域名都要对 8.8.8.8 做一次 TLS 握手（300ms+），
//    YouTube 每个分段、下载器每个线程都要建连，这是码率/多线程的第一大瓶颈
// 2. 关掉全部 sniffing —— outbounds 只有 freedom 直连、没有 routing 规则，嗅探纯属白烧 CPU
// 3. policy 显式大缓冲 + 关闭流量统计 —— 高吞吐时每连接 1MB 缓冲，统计写盘全部停掉
async function generateConfig() {
  const config = {
    log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
    inbounds: [
      { port: ARGO_PORT, protocol: 'vless', settings: { clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], decryption: 'none', fallbacks: [{ dest: 3001 }, { path: "/vless-argo", dest: 3002 }, { path: "/vmess-argo", dest: 3003 }, { path: "/trojan-argo", dest: 3004 }] }, streamSettings: { network: 'tcp' } },
      { port: 3001, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID }], decryption: "none" }, streamSettings: { network: "tcp", security: "none" } },
      { port: 3002, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" } } },
      { port: 3003, listen: "127.0.0.1", protocol: "vmess", settings: { clients: [{ id: UUID, alterId: 0 }] }, streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } } },
      { port: 3004, listen: "127.0.0.1", protocol: "trojan", settings: { clients: [{ password: UUID }] }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" } } },
    ],
    dns: { servers: ["1.1.1.1", "8.8.8.8"], queryStrategy: "UseIPv4" },
    policy: {
      levels: { "0": { handshake: 4, connIdle: 300, uplinkOnly: 0, downlinkOnly: 0, bufferSize: 1024 } },
      system: { statsInboundUplink: false, statsInboundDownlink: false, statsOutboundUplink: false, statsOutboundDownlink: false }
    },
    outbounds: [
      { protocol: "freedom", tag: "direct", settings: { domainStrategy: "UseIPv4" } },
      { protocol: "blackhole", tag: "block" }
    ]
  };
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2));
}

// 内核调优（BBR + 大 TCP 窗口）：容器内通常没有权限，静默失败不影响启动，有权限的宿主上直接生效
async function tuneKernel() {
  const cmd = [
    'sysctl -w net.core.default_qdisc=fq || true',
    'sysctl -w net.ipv4.tcp_congestion_control=bbr || true',
    'sysctl -w net.ipv4.tcp_fastopen=3 || true',
    'sysctl -w net.ipv4.tcp_window_scaling=1 || true',
    'sysctl -w net.ipv4.tcp_rmem="4096 87380 33554432" || true',
    'sysctl -w net.ipv4.tcp_wmem="4096 65536 33554432" || true',
  ].join('; ');
  try {
    await exec(`${cmd} >/dev/null 2>&1`);
    log('kernel tuning attempted');
  } catch (error) {
    // 无权限，忽略
  }
}

// 判断系统架构
function getSystemArchitecture() {
  const arch = os.arch();
  return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm' : 'amd';
}

// 下载单个文件（带重试、超时、流错误兜底）
function downloadOnce(fileName, fileUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (!settled) { settled = true; err ? reject(err) : resolve(fileName); }
    };
    const writer = fs.createWriteStream(fileName);
    writer.on('error', (err) => {
      fs.unlink(fileName, () => { });
      done(new Error(`write ${path.basename(fileName)}: ${err.message}`));
    });
    axios({
      method: 'get',
      url: fileUrl,
      responseType: 'stream',
      timeout: 120000,
      maxContentLength: 200 * 1024 * 1024,
    }).then(response => {
      // 流中途出错也必须兜住，否则 unhandled 'error' 直接崩进程
      response.data.on('error', (err) => {
        writer.destroy();
        fs.unlink(fileName, () => { });
        done(new Error(`stream ${path.basename(fileName)}: ${err.message}`));
      });
      response.data.pipe(writer);
      writer.on('finish', () => {
        writer.close();
        log(`Download ${path.basename(fileName)} successfully`);
        done(null);
      });
    }).catch(err => {
      writer.destroy();
      fs.unlink(fileName, () => { });
      done(new Error(`download ${path.basename(fileName)}: ${err.message}`));
    });
  });
}

// 带重试的下载
async function downloadWithRetry(fileUrl, fileName) {
  let lastErr;
  for (let i = 0; i <= DOWNLOAD_RETRIES; i++) {
    try {
      return await downloadOnce(fileName, fileUrl);
    } catch (err) {
      lastErr = err;
      logErr(err.message, i < DOWNLOAD_RETRIES ? `, retry ${i + 1}/${DOWNLOAD_RETRIES}` : ', giving up');
      await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

// 下载并运行依赖文件
async function downloadFilesAndRun() {
  const architecture = getSystemArchitecture();
  const filesToDownload = getFilesForArchitecture(architecture);

  if (filesToDownload.length === 0) {
    logErr(`Can't find a file for the current architecture`);
    return;
  }

  // 并发下载（互不阻塞，单个失败自动重试）
  const results = await Promise.allSettled(
    filesToDownload.map(f => downloadWithRetry(f.fileUrl, f.fileName))
  );
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    logErr('Error downloading files:', failed.map(r => r.reason && r.reason.message).join(' | '));
    return;
  }

  // 授权：改成 await，杜绝 chmod 没完成就去 exec 导致 EACCES 的竞态
  const filesToAuthorize = NEZHA_PORT ? [npmPath, webPath, botPath] : [phpPath, webPath, botPath];
  try {
    await Promise.all(filesToAuthorize.map(p => fsp.chmod(p, 0o755)));
    log('Empowerment success:', filesToAuthorize.map(p => path.basename(p)).join(', '));
  } catch (err) {
    logErr('Empowerment failed:', err.message);
  }

  // 运行nezha
  if (NEZHA_SERVER && NEZHA_KEY) {
    if (!NEZHA_PORT) {
      const port = NEZHA_SERVER.includes(':') ? NEZHA_SERVER.split(':').pop() : '';
      const tlsPorts = new Set(['443', '8443', '2096', '2087', '2083', '2053']);
      const nezhatls = tlsPorts.has(port) ? 'true' : 'false';
      const configYaml = `
client_secret: ${NEZHA_KEY}
debug: false
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: true
ip_report_period: 1800
report_delay: 4
server: ${NEZHA_SERVER}
skip_connection_count: true
skip_procs_count: true
temperature: false
tls: ${nezhatls}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${UUID}`;

      await fsp.writeFile(path.join(FILE_PATH, 'config.yaml'), configYaml);

      try {
        await exec(`nohup ${phpPath} -c "${FILE_PATH}/config.yaml" >/dev/null 2>&1 &`);
        log(`${phpName} is running`);
        await sleep(1000);
      } catch (error) {
        logErr(`php running error: ${error.message}`);
      }
    } else {
      const tlsPorts = ['443', '8443', '2096', '2087', '2083', '2053'];
      const NEZHA_TLS = tlsPorts.includes(NEZHA_PORT) ? '--tls' : '';
      try {
        await exec(`nohup ${npmPath} -s ${NEZHA_SERVER}:${NEZHA_PORT} -p ${NEZHA_KEY} ${NEZHA_TLS} --disable-auto-update --report-delay 4 --skip-conn --skip-procs >/dev/null 2>&1 &`);
        log(`${npmName} is running`);
        await sleep(1000);
      } catch (error) {
        logErr(`npm running error: ${error.message}`);
      }
    }
  } else {
    log('NEZHA variable is empty,skip running');
  }

  // 运行xray
  try {
    await exec(`nohup ${webPath} -c ${FILE_PATH}/config.json >/dev/null 2>&1 &`);
    log(`${webName} is running`);
    await sleep(1000);
  } catch (error) {
    logErr(`web running error: ${error.message}`);
  }

  // 运行cloudflared（quic 协议多路复用无队头阻塞，YouTube 高码率 / 多线程聚合吞吐收益最大）
  if (fs.existsSync(botPath)) {
    let args;
    if (ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
      args = `tunnel --edge-ip-version 4 --no-autoupdate --protocol ${ARGO_PROTOCOL} run --token ${ARGO_AUTH}`;
    } else if (ARGO_AUTH.match(/TunnelSecret/)) {
      args = `tunnel --edge-ip-version 4 --config ${FILE_PATH}/tunnel.yml run`;
    } else {
      args = `tunnel --edge-ip-version 4 --no-autoupdate --protocol ${ARGO_PROTOCOL} --logfile ${FILE_PATH}/boot.log --loglevel info --url http://localhost:${ARGO_PORT}`;
    }

    try {
      await exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
      log(`${botName} is running`);
      await sleep(2000);
    } catch (error) {
      logErr(`Error executing command: ${error.message}`);
    }
  }
  await sleep(3000);
}

// 根据系统架构返回对应的url
function getFilesForArchitecture(architecture) {
  const base = architecture === 'arm' ? "https://arm64.ssss.nyc.mn" : "https://amd64.ssss.nyc.mn";
  const baseFiles = [
    { fileName: webPath, fileUrl: `${base}/web` },
    { fileName: botPath, fileUrl: `${base}/bot` }
  ];

  if (NEZHA_SERVER && NEZHA_KEY) {
    const agentName = NEZHA_PORT ? 'agent' : 'v1';
    baseFiles.unshift({ fileName: NEZHA_PORT ? npmPath : phpPath, fileUrl: `${base}/${agentName}` });
  }

  return baseFiles;
}

// 写入固定隧道配置
function argoType() {
  if (!ARGO_AUTH || !ARGO_DOMAIN) {
    log("ARGO_DOMAIN or ARGO_AUTH is empty, use quick tunnels");
    return;
  }

  if (ARGO_AUTH.includes('TunnelSecret')) {
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.json'), ARGO_AUTH);
    const tunnelYaml = `
  tunnel: ${ARGO_AUTH.split('"')[11]}
  credentials-file: ${path.join(FILE_PATH, 'tunnel.json')}
  protocol: ${ARGO_PROTOCOL}

  ingress:
    - hostname: ${ARGO_DOMAIN}
      service: http://localhost:${ARGO_PORT}
      originRequest:
        noTLSVerify: true
    - service: http_status:404
  `;
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.yml'), tunnelYaml);
  } else {
    log(`Using token connect to tunnel, please set ${ARGO_PORT} in cloudflare`);
  }
}

// 杀掉 cloudflared 进程
async function killBotProcess() {
  try {
    if (process.platform === 'win32') {
      await exec(`taskkill /f /im ${botName}.exe > nul 2>&1`);
    } else {
      await exec(`pkill -f "[${botName.charAt(0)}]${botName.substring(1)}" > /dev/null 2>&1`);
    }
  } catch (error) {
    // 忽略
  }
}

// 获取隧道域名（固定域名直接用；临时隧道从 boot.log 提取，带重试上限防死循环）
async function extractDomains() {
  if (ARGO_AUTH && ARGO_DOMAIN) {
    log('ARGO_DOMAIN:', ARGO_DOMAIN);
    await generateLinks(ARGO_DOMAIN);
    return;
  }

  const tempArgs = `tunnel --edge-ip-version 4 --no-autoupdate --protocol ${ARGO_PROTOCOL} --logfile ${FILE_PATH}/boot.log --loglevel info --url http://localhost:${ARGO_PORT}`;

  for (let attempt = 1; attempt <= MAX_ARGO_RETRIES; attempt++) {
    let argoDomain = null;
    // boot.log 可能还没写出来，读取失败按空内容处理（原版这里 ENOENT 直接放弃，是 bug）
    const content = await fsp.readFile(bootLogPath, 'utf-8').catch(() => '');
    const m = content.match(/https?:\/\/([^ ]*trycloudflare\.com)\//);
    if (m) {
      argoDomain = m[1];
      log('ArgoDomain:', argoDomain);
      await generateLinks(argoDomain);
      return;
    }

    log(`ArgoDomain not found (attempt ${attempt}/${MAX_ARGO_RETRIES}), restarting bot...`);
    await killBotProcess();
    await fsp.unlink(bootLogPath).catch(() => { });
    try {
      await exec(`nohup ${botPath} ${tempArgs} >/dev/null 2>&1 &`);
      log(`${botName} is running`);
    } catch (error) {
      logErr(`Error executing command: ${error.message}`);
    }
    await sleep(3000);
  }
  logErr('ArgoDomain not found after max retries, giving up');
}

// 获取isp信息
async function getMetaInfo() {
  try {
    const response1 = await axios.get('https://api.ip.sb/geoip', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 });
    if (response1.data && response1.data.country_code && response1.data.isp) {
      return `${response1.data.country_code}-${response1.data.isp}`.replace(/\s+/g, '_');
    }
  } catch (error) {
    try {
      const response2 = await axios.get('http://ip-api.com/json', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 });
      if (response2.data && response2.data.status === 'success' && response2.data.countryCode && response2.data.org) {
        return `${response2.data.countryCode}-${response2.data.org}`.replace(/\s+/g, '_');
      }
    } catch (error) {
      // 静默
    }
  }
  return 'Unknown';
}

// 生成 list 和 sub 信息
async function generateLinks(argoDomain) {
  const ISP = await getMetaInfo();
  const nodeName = NAME ? `${NAME}-${ISP}` : ISP;
  const VMESS = { v: '2', ps: `${nodeName}`, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: argoDomain, path: '/vmess-argo?ed=2560', tls: 'tls', sni: argoDomain, alpn: '', fp: 'firefox' };
  const subTxt = `
vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${nodeName}

vmess://${Buffer.from(JSON.stringify(VMESS)).toString('base64')}

trojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Ftrojan-argo%3Fed%3D2560#${nodeName}
  `;
  subContent = Buffer.from(subTxt).toString('base64');
  await fsp.writeFile(subPath, subContent);
  log(`${FILE_PATH}/sub.txt saved successfully`);
  uploadNodes(); // fire-and-forget，不阻塞订阅服务
}

// 自动上传节点或订阅
async function uploadNodes() {
  try {
    if (UPLOAD_URL && PROJECT_URL) {
      const jsonData = { subscription: [`${PROJECT_URL}/${SUB_PATH}`] };
      const response = await axios.post(`${UPLOAD_URL}/api/add-subscriptions`, jsonData, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });
      if (response && response.status === 200) {
        log('Subscription uploaded successfully');
      }
    } else if (UPLOAD_URL) {
      // 注意：list.txt 需由外部生成；本脚本自身不产出 list.txt
      if (!fs.existsSync(listPath)) return;
      const content = await fsp.readFile(listPath, 'utf-8');
      const nodes = content.split('\n').filter(line => /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line));
      if (nodes.length === 0) return;
      const response = await axios.post(`${UPLOAD_URL}/api/add-nodes`, JSON.stringify({ nodes }), {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });
      if (response && response.status === 200) {
        log('Nodes uploaded successfully');
      }
    }
  } catch (error) {
    if (!(error.response && error.response.status === 400)) {
      logErr('Upload failed:', error.message);
    }
    // 400 = 订阅已存在，静默
  }
}

// 90s后删除相关文件（隐藏痕迹，进程已加载到内存不受影响）
function cleanFiles() {
  setTimeout(async () => {
    const filesToDelete = [bootLogPath, configPath, webPath, botPath];
    if (NEZHA_PORT) {
      filesToDelete.push(npmPath);
    } else if (NEZHA_SERVER && NEZHA_KEY) {
      filesToDelete.push(phpPath);
    }
    if (process.platform === 'win32') {
      exec(`del /f /q ${filesToDelete.join(' ')} > nul 2>&1`).catch(() => { });
    } else {
      exec(`rm -rf ${filesToDelete.join(' ')} >/dev/null 2>&1`).catch(() => { });
    }
    console.clear();
    log('App is running');
    log('Thank you for using this script, enjoy!');
  }, 90000);
}

// 自动访问项目URL（保活）
async function AddVisitTask() {
  if (!AUTO_ACCESS || !PROJECT_URL) {
    log("Skipping adding automatic access task");
    return;
  }
  try {
    await axios.post('https://oooo.serv00.net/add-url', { url: PROJECT_URL }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    log('automatic access task added successfully');
  } catch (error) {
    logErr(`Add automatic access task failed: ${error.message}`);
  }
}

// 主运行逻辑
async function startserver() {
  try {
    await tuneKernel();       // BBR + TCP 窗口调优（无权限则静默跳过）
    argoType();
    await deleteNodes();      // 先删订阅器上的旧节点（读 sub.txt 是同步完成的，必须在 cleanup 之前）
    await cleanupOldFiles();  // 再清空运行目录
    await generateConfig();
    await downloadFilesAndRun();
    await extractDomains();
    await AddVisitTask();
  } catch (error) {
    logErr('Error in startserver:', error.message);
  }
}
startserver();

// 90s 后开始清理
cleanFiles();

// ---------- HTTP 服务器 ----------
// 首页缓存：只读一次磁盘，之后全走内存（原来每个请求都 readFile，浪费 IO）
let indexCache = null;
async function getIndexPage() {
  if (indexCache !== null) return indexCache;
  try {
    indexCache = await fsp.readFile(path.join(__dirname, 'index.html'), 'utf8');
  } catch (err) {
    indexCache = '';
  }
  return indexCache;
}

// /sub 的文件兜底也缓存住，避免每次请求都读盘
let subFileCache = null;
async function getSubFromFile() {
  if (subFileCache !== null) return subFileCache;
  try {
    subFileCache = await fsp.readFile(subPath, 'utf-8');
  } catch (err) {
    subFileCache = '';
  }
  return subFileCache;
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // 订阅路由
  if (urlPath === `/${SUB_PATH}`) {
    const body = subContent || await getSubFromFile();
    if (body) {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',          // 订阅必须实时，禁止中间层缓存旧节点
        'Connection': 'keep-alive'
      });
      res.end(body);
    } else {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Subscription content not yet available, please try again later.');
    }
    return;
  }

  // 根路由: /
  if (urlPath === '/') {
    const data = await getIndexPage();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data || "Hello world!<br><br>You can access /" + SUB_PATH + " to get your nodes!");
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

// 长连接超时对齐常见 LB 的 60s，避免订阅端频繁重建 TCP（性能）
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, () => log(`http server is running on port:${PORT}!`));
