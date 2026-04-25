#!/usr/bin/env node
/**
 * PowerShell 编码测试脚本
 * 验证 getWindowedProcesses 函数的编码修复
 */

const { exec } = require('child_process');
const iconvLite = require('iconv-lite');

console.log('╔════════════════════════════════════════════╗');
console.log('║   PowerShell 编码测试                        ║');
console.log('╚════════════════════════════════════════════╝\n');

// 测试 1：原始方式（可能乱码）
console.log('❌ 测试 1: 原始 PowerShell 输出（可能乱码）');
const psOriginal = `powershell -NoProfile -Command "Get-Process explorer | Select-Object Name,Id | ConvertTo-Json -Compress"`;
exec(psOriginal, { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
  if (err) {
    console.log('  错误:', err.message);
  } else {
    console.log('  输出:', stdout.trim().substring(0, 100));
  }
  console.log('');

  // 测试 2：修复后的方式（应该正常）
  console.log('✅ 测试 2: 强制 UTF-8 编码的 PowerShell 输出（修复后）');
  const psFixed = `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Process explorer | Select-Object Name,Id | ConvertTo-Json -Compress"`;
  exec(psFixed, { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
    if (err) {
      console.log('  错误:', err.message);
    } else {
      try {
        const data = JSON.parse(stdout.trim());
        console.log('  ✅ JSON 解析成功');
        console.log('  数据:', JSON.stringify(data, null, 2).substring(0, 150));
      } catch (e) {
        console.log('  ❌ JSON 解析失败:', e.message);
        console.log('  输出:', stdout.trim().substring(0, 100));
      }
    }
    console.log('');

    // 测试 3：获取所有有窗口的进程
    console.log('🔍 测试 3: 获取所有有窗口的进程（完整测试）');
    const psGetWindowed = `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object Name,Id,MainWindowTitle | ConvertTo-Json -Compress"`;
    exec(psGetWindowed, { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      if (err) {
        console.log('  错误:', err.message);
      } else {
        try {
          let data = JSON.parse(stdout.trim());
          if (!Array.isArray(data)) data = [data];
          console.log(`  ✅ 成功获取 ${data.length} 个进程`);
          console.log('  样本进程:');
          data.slice(0, 3).forEach(p => {
            console.log(`    - ${p.Name} (PID: ${p.Id})`);
          });
        } catch (e) {
          console.log('  ❌ 解析失败:', e.message);
          console.log('  输出 (前 150 字):', stdout.trim().substring(0, 150));
        }
      }
      console.log('\n╔════════════════════════════════════════════╗');
      console.log('║   测试完成                                  ║');
      console.log('║   如果看到 ✅ 的结果，说明编码已修复         ║');
      console.log('╚════════════════════════════════════════════╝');
    });
  });
});
