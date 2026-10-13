/**
 * dsh-writer-m — client half（浏览器半区 = 写作工作台）
 *
 * ⚠️ 这个文件不是手写的最终产物：它由 src-client/ 下按序号排列的片段
 * 经 scripts/build-client.mjs 拼装而成。要改代码请改片段，别改 lib/client.js。
 *
 * 形态说明（这是仓外插件必须自己复刻的那一步）：
 * 产物是一个 lazy-CJS factory —— 一段脚本，向页面的模块加载器登记包名和一个
 * factory(require)。require 只能要平台模块表里有的东西（react / react-dom /
 * @deepseek-ai/cordis / ui-slots / ui-primitives / dockkit），其余依赖全部内联。
 * 所以这里除了 react 之外不需要（也不能）require 任何东西。
 */
window.__ModuleLoader__.load({
  id: 'dsh-writer-m',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const NS = 'dsh-writer-m'
