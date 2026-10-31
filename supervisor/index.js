// supervisor/index.js
const path = require('path');
const { readBookState } = require('./state-reader');
const { decideNextAction } = require('./router');
const { validateOutput } = require('./validator');

// ⚠️ 这里需要你根据项目实际情况调整导入路径
// 假设 runStep 从 lib/index.js 导出（如果没有导出，见下方“入口修改”说明）
let runStep;
try {
  ({ runStep } = require('../lib/index.js'));
} catch (e) {
  runStep = null;
}

/**
 * 对一本书执行一轮 Supervisor 监督循环（一次只推进一步）
 * @param {string} bookDir - 书的根目录绝对路径
 * @param {object} options - 传给 runStep 的额外参数（如 genre、channel）
 * @returns {object} 本轮执行结果
 */
async function superviseOnce(bookDir, options = {}) {
  // 1. 读状态
  const state = readBookState(bookDir);
  console.log('[Supervisor] 当前状态:', JSON.stringify(state, null, 2));

  // 2. 决策
  const action = decideNextAction(state);
  console.log('[Supervisor] 决策:', action);

  if (action.action === 'done') {
    return { success: true, action, message: '所有步骤已完成' };
  }

  // 3. 执行（调用现有的 runStep）
  if (!runStep) {
    return { success: false, action, message: 'runStep 未导出，请检查 lib/index.js' };
  }

  try {
    console.log(`[Supervisor] 正在执行: ${action.step_id}${action.chapter ? ` 第${action.chapter}章` : ''}`);
    await runStep({
      bookDir,
      step: action.step_id,
      chapter: action.chapter,
      ...options,
    });
  } catch (err) {
    console.error('[Supervisor] 执行失败:', err.message);
    return { success: false, action, message: `runStep 执行失败: ${err.message}` };
  }

  // 4. 验收
  const validation = validateOutput(bookDir, action);
  console.log('[Supervisor] 验收结果:', validation);

  if (!validation.passed) {
    return { success: false, action, message: `验收未通过: ${validation.reason}` };
  }

  return { success: true, action, message: '本轮执行并验收通过' };
}

/**
 * 对一本书循环执行 Supervisor，直到完成或达到最大轮数
 * @param {string} bookDir
 * @param {object} options
 * @param {number} maxRounds - 最大轮数，防止无限循环
 */
async function superviseLoop(bookDir, options = {}, maxRounds = 20) {
  for (let i = 0; i < maxRounds; i++) {
    console.log(`\n===== Supervisor 第 ${i + 1} 轮 =====`);
    const result = await superviseOnce(bookDir, options);
    if (!result.success) {
      console.error('[Supervisor] 循环终止:', result.message);
      return result;
    }
    if (result.action.action === 'done') {
      console.log('[Supervisor] 全部完成');
      return result;
    }
  }
  return { success: false, message: `达到最大轮数 ${maxRounds}，仍未完成` };
}

module.exports = { superviseOnce, superviseLoop };