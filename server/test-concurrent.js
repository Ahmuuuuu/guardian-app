/**
 * Guardian 服务器并发测试脚本（方案二）
 * 
 * 使用方法：
 *   1. 启动服务器：npm start
 *   2. 另开终端运行测试：node test-concurrent.js
 * 
 * 配置说明：
 *   - concurrency: 同时发送的请求数
 *   - totalRequests: 总共发送多少请求
 *   - requestsPerSecond: 每秒发送多少请求（可选，用于限流）
 */

const http = require('http');
const { performance } = require('perf_hooks');

// ===== 配置部分 =====
const CONFIG = {
  host: 'localhost',
  port: 3847,

  // 并发测试参数
  concurrency: 500,        // 同时进行的请求数
  totalRequests: 500,      // 总请求数

  // 服务器认证信息
  adminUser: 'admin',
  adminPass: 'guardian2026',

  // 超时设置
  timeout: 10000,          // 单个请求超时（毫秒）

  // 限流（可选）
  requestsPerSecond: 0     // 0 = 不限流；>0 则限制每秒请求数
};

// ===== 状态跟踪 =====
let completed = 0;
let failed = 0;
let token = null;
const startTime = performance.now();
const statusCodes = {};
const responseTimes = [];

// ===== 工具函数 =====

/**
 * 发送 HTTP 请求
 */
function makeRequest(method, path, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const defaultHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };

    if (token && !headers['Authorization']) {
      defaultHeaders['Authorization'] = `Bearer ${token}`;
    }

    const body = payload ? JSON.stringify(payload) : null;

    const options = {
      hostname: CONFIG.host,
      port: CONFIG.port,
      path,
      method,
      headers: {
        ...defaultHeaders,
        'Content-Length': body ? Buffer.byteLength(body) : 0
      },
      timeout: CONFIG.timeout
    };

    const reqStartTime = performance.now();

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        const responseTime = performance.now() - reqStartTime;
        responseTimes.push(responseTime);

        statusCodes[res.statusCode] = (statusCodes[res.statusCode] || 0) + 1;
        completed++;

        resolve({
          statusCode: res.statusCode,
          responseTime,
          data: data ? JSON.parse(data) : null
        });
      });
    });

    req.on('error', (err) => {
      failed++;
      reject(err);
    });

    req.on('timeout', () => {
      failed++;
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * 登录获取 token
 */
async function login() {
  try {
    console.log('📝 正在登录...');
    const res = await makeRequest('POST', '/api/admin/login', {
      username: CONFIG.adminUser,
      password: CONFIG.adminPass
    });

    if (res.statusCode === 200 && res.data.token) {
      token = res.data.token;
      console.log('✅ 登录成功，获得 token\n');
      return true;
    } else {
      console.error('❌ 登录失败:', res.data);
      return false;
    }
  } catch (err) {
    console.error('❌ 登录异常:', err.message);
    return false;
  }
}

/**
 * 限流控制
 */
async function throttle() {
  if (CONFIG.requestsPerSecond <= 0) return;

  const delay = 1000 / CONFIG.requestsPerSecond;
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * 单个并发测试请求
 */
async function testRequest(index) {
  await throttle();

  try {
    // 交替测试不同的 API
    const testType = index % 3;
    let res;

    switch (testType) {
      case 0:
        // 测试获取客户端列表
        res = await makeRequest('GET', '/api/clients');
        break;
      case 1:
        // 测试广播命令
        res = await makeRequest('POST', '/api/broadcast', {
          action: 'test_lock',
          message: `Test request #${index}`,
          timestamp: Date.now()
        });
        break;
      case 2:
        // 测试学生 CRUD
        res = await makeRequest('GET', '/api/students');
        break;
    }

    return { index, success: true, statusCode: res.statusCode };
  } catch (err) {
    return { index, success: false, error: err.message };
  }
}

/**
 * 格式化时间
 */
function formatTime(ms) {
  return ms.toFixed(2) + 'ms';
}

/**
 * 计算统计信息
 */
function calculateStats() {
  responseTimes.sort((a, b) => a - b);

  const sum = responseTimes.reduce((a, b) => a + b, 0);
  const avg = sum / responseTimes.length;
  const min = responseTimes[0];
  const max = responseTimes[responseTimes.length - 1];
  const p50 = responseTimes[Math.floor(responseTimes.length * 0.5)];
  const p95 = responseTimes[Math.floor(responseTimes.length * 0.95)];
  const p99 = responseTimes[Math.floor(responseTimes.length * 0.99)];

  return { avg, min, max, p50, p95, p99 };
}

/**
 * 主测试函数
 */
async function runConcurrentTest() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   Guardian 并发压力测试                      ║');
  console.log('╚════════════════════════════════════════════╝\n');

  console.log(`⚙️  测试配置:`);
  console.log(`   并发数: ${CONFIG.concurrency}`);
  console.log(`   总请求: ${CONFIG.totalRequests}`);
  console.log(`   目标: http://${CONFIG.host}:${CONFIG.port}`);
  if (CONFIG.requestsPerSecond > 0) {
    console.log(`   限流: ${CONFIG.requestsPerSecond} req/s`);
  }
  console.log('');

  // 1. 登录
  const loginSuccess = await login();
  if (!loginSuccess) {
    console.error('❌ 登录失败，无法继续测试');
    process.exit(1);
  }

  // 2. 发送并发请求
  console.log(`🚀 开始发送 ${CONFIG.totalRequests} 个请求 (并发: ${CONFIG.concurrency})...\n`);

  const allPromises = [];
  const batchSize = CONFIG.concurrency;

  for (let i = 0; i < CONFIG.totalRequests; i++) {
    allPromises.push(testRequest(i).catch(() => { }));

    // 进度显示
    if ((i + 1) % 50 === 0) {
      process.stdout.write(`\r📊 已发送: ${i + 1}/${CONFIG.totalRequests}`);
    }

    // 控制并发数
    if (allPromises.length >= batchSize) {
      await Promise.race(allPromises);
      allPromises.splice(0, 1);
    }
  }

  // 等待所有请求完成
  console.log('\n⏳ 等待所有请求完成...');
  await Promise.all(allPromises);

  // 3. 统计结果
  const endTime = performance.now();
  const totalDuration = (endTime - startTime) / 1000;
  const stats = calculateStats();

  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║          📊 测试结果统计                    ║');
  console.log('╚════════════════════════════════════════════╝\n');

  console.log(`⏱️  总耗时: ${totalDuration.toFixed(2)}s`);
  console.log(`✅ 成功: ${completed} 请求`);
  console.log(`❌ 失败: ${failed} 请求`);
  console.log(`📈 成功率: ${((completed / CONFIG.totalRequests) * 100).toFixed(2)}%\n`);

  console.log(`🚀 性能指标:`);
  console.log(`   吞吐量: ${(CONFIG.totalRequests / totalDuration).toFixed(2)} req/s`);
  console.log(`   平均响应时间: ${formatTime(stats.avg)}`);
  console.log(`   最小响应时间: ${formatTime(stats.min)}`);
  console.log(`   最大响应时间: ${formatTime(stats.max)}`);
  console.log(`   P50 (中位数): ${formatTime(stats.p50)}`);
  console.log(`   P95: ${formatTime(stats.p95)}`);
  console.log(`   P99: ${formatTime(stats.p99)}\n`);

  console.log(`📊 HTTP 状态码分布:`);
  Object.entries(statusCodes)
    .sort(([a], [b]) => a - b)
    .forEach(([code, count]) => {
      const percentage = ((count / completed) * 100).toFixed(2);
      console.log(`   ${code}: ${count} (${percentage}%)`);
    });

  console.log('');
  console.log('✨ 测试完成！');

  // 性能评估
  console.log('\n📋 性能评估:');
  if (stats.avg < 50) {
    console.log('   ✅ 响应时间优秀 (< 50ms)');
  } else if (stats.avg < 200) {
    console.log('   ⚠️  响应时间中等 (50-200ms)');
  } else {
    console.log('   ❌ 响应时间较长 (> 200ms)');
  }

  if (failed / CONFIG.totalRequests < 0.01) {
    console.log('   ✅ 错误率低 (< 1%)');
  } else if (failed / CONFIG.totalRequests < 0.05) {
    console.log('   ⚠️  错误率中等 (1-5%)');
  } else {
    console.log('   ❌ 错误率高 (> 5%)');
  }

  console.log('');
}

// ===== 入口 =====
runConcurrentTest().catch(err => {
  console.error('❌ 测试异常:', err);
  process.exit(1);
});
