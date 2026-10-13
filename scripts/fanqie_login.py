# -*- coding: utf-8 -*-
"""番茄小说作家专区「登录态」工具（dsh-writer-m 内置，供宿主 route('fanqie') 调用）。

四个动作：
  --action probe      只读探活：用持久化 profile 打开作家后台（默认 headless），
                      页内 fetch /api/author/account/info/v0/，判定「登录态还在不在」。
  --action login      打开可见浏览器等待扫码登录，成功后落一份会话快照。
  --action keepalive  访问首页 + 作家后台刷新服务端 cookie，再落一次 storage_state。
  --action restore    把一份会话快照（storage_state JSON）里的 cookie 导回 profile，
                      用于「profile 里的 cookie 掉了、但快照还在」的免扫码恢复。
  --action selftest   不联网：固定样例回归「判定函数」。

为什么单独写这个脚本（对应缺陷教训）：
  旧脚本用 (await r.text()).slice(0, 1000) 取接口原文，再 json.loads —— 响应体
  超过 1000 字符时解析必然失败，于是「已登录」被误判成 non-json/False。
  这里一不截断响应体，二把判定收敛进纯函数 judge()，用 selftest 钉死回归。

输出契约（宿主只解析最后一行，见 lib/index.js 的 route('fanqie')）：
  FANQIE-RESULT {"ok":true,"action":"probe","loggedIn":true,"authorName":"…",…}
  loggedIn 三态：true=已登录 / false=未登录（附原因）/ null=无法判定（附原因）。
  其余 stdout 行是人类可读进度日志。
"""
import argparse
import json
import os
import sys
import time

# 生产端钉住 UTF-8：Windows 下 stdout 是管道时 Python 默认按本地代码页（cp936）编码，
# 宿主按 UTF-8 读就会把中文读成乱码。宿主侧另有 PYTHONIOENCODING 兜底，这里再钉一遍。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

MANAGE = "https://fanqienovel.com/main/writer/book-manage"
HOME = "https://fanqienovel.com/"
ACC_API = "https://fanqienovel.com/api/author/account/info/v0/"

AUTH_KEYS = ("author_id", "author_name", "nickname", "name", "pen_name", "uid", "user_id", "avatar", "author_level")
CORE_COOKIES = ("sessionid", "sessionid_ss", "sid_guard", "sid_tt", "uid_tt", "uid_tt_ss", "gfkadpd", "n_mh", "session_tlb_tag", "passport_csrf_token")

# 页内探针：整段取回响应体（旧版在这里 slice(0,1000)，是误判的根因）。
JS_FETCH = """async () => {
  const out = {};
  try {
    const r = await fetch('/api/author/account/info/v0/', {
      credentials: 'include',
      headers: {'accept': 'application/json, text/plain, */*'},
    });
    out.status = r.status;
    out.ctype = r.headers.get('content-type') || '';
    out.text = await r.text();
  } catch (e) { out.err = String(e).slice(0, 300); }
  out.url = location.href;
  out.hasLoginForm = !!document.querySelector('input[placeholder*="手机"], input[placeholder*="验证码"]');
  return out;
}"""

_logf = None


def log(*a):
    s = " ".join(str(x) for x in a)
    if _logf is not None:
        try:
            _logf.write(s + "\n")
            _logf.flush()
        except Exception:
            pass
    try:
        print(s, flush=True)
    except Exception:
        pass


def done(result, report=""):
    """统一出口：写报告文件 + 末行 FANQIE-RESULT（宿主只认这一行）。"""
    if report:
        try:
            with open(report, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=1)
        except Exception as e:
            log("report write err:", type(e).__name__, str(e)[:200])
    try:
        print("FANQIE-RESULT " + json.dumps(result, ensure_ascii=False), flush=True)
    except Exception:
        pass
    try:
        if _logf is not None:
            _logf.close()
    except Exception:
        pass
    sys.exit(0 if result.get("ok") is True else 1)


# ---------------------------------------------------------------------------
# 判定函数（纯函数，selftest 直接喂样例）
# ---------------------------------------------------------------------------

def judge(status, text, url="", has_login_form=False):
    """返回 (logged_in, reason, account)。logged_in：True / False / None（无法判定）。"""
    body = text if isinstance(text, str) else ""
    if status in (401, 403):
        return False, "HTTP %s 未授权，登录态已失效" % status, {}
    try:
        j = json.loads(body)
    except Exception:
        if has_login_form or "/login" in (url or ""):
            return False, "页面停在登录页（未登录）", {}
        head = " ".join(body.split())[:160]
        return None, "响应不是 JSON（HTTP %s），无法判定：%s" % (status, head if head else "(空响应)"), {}
    if not isinstance(j, dict):
        return None, "响应 JSON 不是对象，无法判定", {}
    data = j.get("data")
    if isinstance(data, dict) and any(data.get(k) for k in AUTH_KEYS):
        name = data.get("author_name") or data.get("nickname") or data.get("name") or data.get("pen_name") or ""
        return True, "已登录", {"authorName": str(name)}
    if isinstance(data, dict) and len(data) > 2:
        return True, "已登录（接口 data 非空）", {"authorName": ""}
    code = j.get("code")
    if code in (0, "0") and not data:
        return False, "接口返回 code=0 但 data 为空（未登录）", {}
    if code not in (None, 0, "0"):
        msg = j.get("message") or j.get("msg") or ""
        return False, "接口返回 code=%s %s（未登录）" % (code, msg), {}
    return None, "响应结构无法识别，无法判定：%s" % json.dumps(j, ensure_ascii=False)[:160], {}


def cookie_report(cookies):
    """最短命的登录 cookie 才是登录态的真正保质期——比「cookie 总数」有用得多。"""
    core = {}
    total = 0
    for c in cookies or []:
        if "fanqienovel.com" not in str(c.get("domain", "")):
            continue
        total += 1
        name = str(c.get("name") or "")
        exp = c.get("expires")
        if name in CORE_COOKIES and isinstance(exp, (int, float)) and exp > 0:
            core[name] = float(exp)
    out = {"cookies": total}
    if core:
        name = min(core, key=lambda k: core[k])
        exp = core[name]
        out["nearestCookie"] = name
        out["expiresAt"] = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(exp))
        out["expiresInDays"] = round((exp - time.time()) / 86400.0, 2)
    return out


def probe_page(page):
    """返回 (logged_in, reason, account, raw)。"""
    try:
        raw = page.evaluate(JS_FETCH) or {}
    except Exception as e:
        return None, "页内探针异常：%s %s" % (type(e).__name__, str(e)[:160]), {}, {}
    if raw.get("err"):
        return None, "页内 fetch 失败：%s" % str(raw.get("err"))[:200], {}, raw
    ok, reason, account = judge(raw.get("status"), raw.get("text"), raw.get("url", ""), bool(raw.get("hasLoginForm")))
    return ok, reason, account, raw


def _load_state_cookies(path):
    """从 storage_state JSON 里取 cookie（只保留 Playwright 认的字段）。"""
    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as e:
        log("读取快照失败：", type(e).__name__, str(e)[:200])
        return []
    out = []
    for c in (data.get("cookies") or []):
        if not isinstance(c, dict) or not c.get("name") or not c.get("domain"):
            continue
        out.append({k: c[k] for k in ("name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite") if k in c})
    return out


def _json_fails(text):
    try:
        json.loads(text)
        return False
    except Exception:
        return True


def _cookie_case():
    now = time.time()
    cs = [
        {"name": "gfkadpd", "domain": ".fanqienovel.com", "expires": now + 86400},
        {"name": "sessionid", "domain": ".fanqienovel.com", "expires": now + 86400 * 60},
        {"name": "other", "domain": ".fanqienovel.com", "expires": now + 10},
    ]
    r = cookie_report(cs)
    return r.get("nearestCookie") == "gfkadpd" and r.get("cookies") == 3


def selftest():
    cases = []
    long_pad = "汉" * 1400
    full = json.dumps({"code": 0, "data": {"pad": long_pad, "author_id": 123, "author_name": "瘸子骑龙士"}}, ensure_ascii=False)
    cases.append(("长响应体（>1000 字符）也必须判定为已登录", judge(200, full)[0] is True, "judge(200, 1400+ 字符 JSON)"))
    cases.append(("旧写法 slice(0,1000) 会解析失败（证明截断确实致命）", _json_fails(full[:1000]), "json.loads(body[:1000]) 抛错"))
    cases.append(("401 → 未登录", judge(401, "")[0] is False, "judge(401)"))
    cases.append(("code=0 + data 空 → 未登录", judge(200, '{"code":0,"data":null}')[0] is False, "judge(200, empty data)"))
    cases.append(("code!=0 → 未登录", judge(200, '{"code":1001,"message":"未登录"}')[0] is False, "judge(200, code=1001)"))
    cases.append(("登录页 HTML + 登录框 → 未登录", judge(200, "<html>登录</html>", "https://fanqienovel.com/login", True)[0] is False, "judge(login page)"))
    cases.append(("非 JSON 且无登录框 → 无法判定（不是 False）", judge(200, "<html>502</html>", "https://fanqienovel.com/x", False)[0] is None, "judge(unknown)"))
    cases.append(("作者名从 data.author_name 取出", judge(200, full)[2].get("authorName") == "瘸子骑龙士", "account.authorName"))
    cases.append(("cookie 报告取最短命的核心 cookie", _cookie_case(), "cookie_report"))
    bad = [n for n, ok, _ in cases if ok is not True]
    for n, ok, d in cases:
        print(("  ok   " if ok is True else "  FAIL ") + n + "   [" + d + "]")
    print("FANQIE-SELFTEST ok=%d fail=%d" % (len(cases) - len(bad), len(bad)))
    return 1 if bad else 0


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    global _logf
    ap = argparse.ArgumentParser()
    ap.add_argument("--action", default="probe", choices=["probe", "login", "keepalive", "restore", "selftest"])
    ap.add_argument("--profile", default="", help="Playwright 持久化登录态目录（除 selftest 外必填）")
    ap.add_argument("--log", default="")
    ap.add_argument("--report", default="")
    ap.add_argument("--state", default="", help="登录成功后的会话快照（storage_state）落盘路径")
    ap.add_argument("--minutes", type=int, default=45, help="login：等待扫码的分钟数")
    ap.add_argument("--shot", type=int, default=20, help="login：每隔几秒截一张图（0=关）")
    ap.add_argument("--shot-dir", default="")
    ap.add_argument("--headed", action="store_true", help="probe/keepalive/restore 也用可见窗口（默认 headless）")
    ap.add_argument("--restore-from", default="", help="restore：要导回的 storage_state JSON（会话快照）路径")
    a = ap.parse_args()

    if a.action == "selftest":
        sys.exit(selftest())

    if a.log:
        try:
            _logf = open(a.log, "a", encoding="utf-8")
        except Exception:
            _logf = None
    base = {"action": a.action, "profile": a.profile, "startedAt": time.strftime("%Y-%m-%d %H:%M:%S")}

    if not a.profile:
        base.update({"ok": False, "loggedIn": None, "reason": "缺少 --profile（登录态目录）"})
        log("错误：缺少 --profile（登录态目录）")
        done(base, a.report)

    log("=" * 70)
    log("[%s] fanqie_login action=%s profile=%s" % (time.strftime("%H:%M:%S"), a.action, a.profile))
    os.makedirs(a.profile, exist_ok=True)
    state = a.state or os.path.join(os.path.dirname(os.path.abspath(a.profile)), "fanqie-session.json")
    shot_dir = a.shot_dir or (os.path.dirname(os.path.abspath(a.log)) if a.log else os.path.dirname(os.path.abspath(a.profile)))
    try:
        os.makedirs(shot_dir, exist_ok=True)
    except Exception:
        pass

    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        base.update({"ok": False, "loggedIn": None, "reason": "未安装 playwright：%s" % str(e)[:160]})
        log("错误：未安装 playwright ——", str(e)[:200])
        done(base, a.report)

    headless = not a.headed
    if a.action == "login":
        headless = False
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                a.profile, headless=headless, locale="zh-CN",
                viewport={"width": 1500, "height": 950},
                args=["--disable-blink-features=AutomationControlled"],
            )
            page = ctx.pages[0] if ctx.pages else ctx.new_page()

            if a.action == "restore":
                # 先导 cookie 再导航：add_cookies 对未导航的空白上下文最可靠。
                cookies = _load_state_cookies(a.restore_from)
                base["restoreFrom"] = a.restore_from
                base["restoredCookies"] = len(cookies)
                if not cookies:
                    log("错误：快照里没有可用 cookie ->", a.restore_from)
                    base.update({"ok": False, "loggedIn": None, "reason": "快照无 cookie 或文件不可读：%s" % a.restore_from})
                    try:
                        ctx.close()
                    except Exception:
                        pass
                    done(base, a.report)
                try:
                    ctx.add_cookies(cookies)
                    log("[%s] 已从快照导回 %d 条 cookie" % (time.strftime("%H:%M:%S"), len(cookies)))
                except Exception as e:
                    log("导回 cookie 失败：", type(e).__name__, str(e)[:200])

            try:
                page.goto(MANAGE, wait_until="domcontentloaded", timeout=60000)
            except Exception as e:
                log("goto 失败：", type(e).__name__, str(e)[:200])

            ok, reason, account, raw = probe_page(page)
            log("[%s] 探活：loggedIn=%s reason=%s url=%s" % (time.strftime("%H:%M:%S"), ok, reason, (raw or {}).get("url", "")))
            base.update({"loggedIn": ok, "reason": reason, "authorName": account.get("authorName", ""), "url": (raw or {}).get("url", "")})

            if a.action == "keepalive":
                # 真导航才会让服务端续期 cookie；探活用的 fetch 不算。
                if ok is True:
                    try:
                        page.goto(HOME, wait_until="domcontentloaded", timeout=60000)
                        page.goto(MANAGE, wait_until="domcontentloaded", timeout=60000)
                        ctx.storage_state(path=state)
                        base["refreshed"] = True
                        base["statePath"] = state
                        log("[%s] 保活完成，登录态快照 -> %s" % (time.strftime("%H:%M:%S"), state))
                    except Exception as e:
                        base["refreshed"] = False
                        log("保活失败：", type(e).__name__, str(e)[:200])
                else:
                    base["refreshed"] = False
            elif a.action == "login" and ok is not True:
                log(">>> 请在已弹出的浏览器窗口里扫码登录（番茄小说 App）。登录成功后本脚本自动继续，最多等 %d 分钟。" % a.minutes)
                deadline = time.time() + a.minutes * 60
                last_shot = 0.0
                while time.time() < deadline:
                    time.sleep(4)
                    ok, reason, account, raw = probe_page(page)
                    log("[%s] 等待扫码：loggedIn=%s reason=%s" % (time.strftime("%H:%M:%S"), ok, reason))
                    if ok is True:
                        break
                    if a.shot > 0 and time.time() - last_shot >= a.shot:
                        last_shot = time.time()
                        try:
                            page.screenshot(path=os.path.join(shot_dir, "fanqie-login-live.png"))
                            log("[%s] 截图 -> fanqie-login-live.png" % time.strftime("%H:%M:%S"))
                        except Exception as e:
                            log("截图失败：", type(e).__name__, str(e)[:120])
                base.update({"loggedIn": ok, "reason": reason, "authorName": account.get("authorName", ""), "url": (raw or {}).get("url", "")})

            if ok is True and a.action in ("login", "keepalive"):
                try:
                    ctx.storage_state(path=state)
                    base["statePath"] = state
                    log("[%s] 会话快照 -> %s" % (time.strftime("%H:%M:%S"), state))
                except Exception as e:
                    log("storage_state 失败：", type(e).__name__, str(e)[:200])
            if ok is True and a.action == "login":
                try:
                    page.screenshot(path=os.path.join(shot_dir, "fanqie-login-done.png"))
                except Exception:
                    pass

            try:
                base.update(cookie_report(ctx.cookies()))
            except Exception as e:
                log("cookie 读取失败：", type(e).__name__, str(e)[:160])
            try:
                ctx.close()
            except Exception:
                pass

            if a.action == "login":
                base["ok"] = ok is True
                if ok is not True:
                    base["reason"] = "等待超时，未检测到登录：%s" % base.get("reason", "")
            elif a.action == "restore":
                base["ok"] = ok is True
                if ok is not True:
                    base["reason"] = "快照已失效，需要重新扫码登录：%s" % base.get("reason", "")
            else:
                base["ok"] = True
            base["finishedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            log("[%s] 结束：loggedIn=%s（%s）" % (time.strftime("%H:%M:%S"), base.get("loggedIn"), base.get("reason", "")))
            done(base, a.report)
    except Exception as e:
        base.update({"ok": False, "loggedIn": None, "reason": "运行异常：%s %s" % (type(e).__name__, str(e)[:200])})
        log("运行异常：", type(e).__name__, str(e)[:300])
        done(base, a.report)


if __name__ == "__main__":
    main()
