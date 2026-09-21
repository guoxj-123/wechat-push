#!/usr/bin/env python3
"""通过 wb-push.js 分段推送长文本到微信（ClawBot / iLink 通道）。

为什么需要它：wb-push.js 的 --send 模式内部会把正文 truncate 到 1500 字符，
直接喂长文本会被静默截断，且不报错。本脚本负责切段 + 逐段调用 + 限流间隔。

用法:
    python wb-push-long.py <文件路径> [--title "标题"] [--max 1400] [--gap 2]

参数:
    file    待推送的文本文件（UTF-8）
    --title 标题；省略时取文件第一行
    --max   每段最大字符数，默认 1400（wb-push.js 上限 1500，留余量）
    --gap   段之间的间隔秒数，默认 2（iLink 限额约 7 条/5 分钟）

示例:
    python wb-push-long.py "report.md" --title "日报"
    python wb-push-long.py "/path/to/长文.md" --title "标题"
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import time

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUSH_JS = os.path.join(SKILL_DIR, "scripts", "wb-push.js")


def _managed_node_candidates():
    """扫描 WorkBuddy 托管 node 目录，返回所有 node 可执行文件路径。

    不写死版本号——托管目录形如
    ~/.workbuddy/binaries/node/versions/<版本号>/node.exe，
    版本号随 WorkBuddy 升级而变，写死会让其他用户直接落到回退分支甚至失败。
    """
    home = os.path.expanduser("~")
    versions_dir = os.path.join(home, ".workbuddy", "binaries", "node", "versions")
    found = []
    try:
        for name in os.listdir(versions_dir):
            for exe in ("node.exe", "node"):
                p = os.path.join(versions_dir, name, exe)
                if os.path.exists(p):
                    found.append(p)
    except OSError:
        pass
    # 版本号降序，优先取最新版
    found.sort(key=lambda p: os.path.basename(os.path.dirname(p)), reverse=True)
    return found


def find_node():
    """优先用 WorkBuddy 托管的 node（自动探测版本），回退到 PATH 中的 node。"""
    candidates = _managed_node_candidates()
    for n in ("node", "node.exe"):
        p = shutil.which(n)
        if p and p not in candidates:
            candidates.append(p)
    for c in candidates:
        if c and os.path.exists(c):
            return c
    sys.exit(
        "找不到 node，无法调用 wb-push.js。"
        "请在 WorkBuddy 对话内执行，或自行安装 Node.js 18+ 并加入 PATH。"
    )


def split_text(text, maxlen):
    """按空行切成段落，贪心合并到每段 <= maxlen；超长段落再硬切。"""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]

    chunks = []
    for p in paragraphs:
        while len(p) > maxlen:  # 单段超长，按句子/标点回退切分
            cut = p.rfind("。", 0, maxlen)
            if cut < maxlen * 0.5:
                cut = p.rfind("\n", 0, maxlen)
            if cut < maxlen * 0.5:
                cut = maxlen
            else:
                cut += 1
            chunks.append(p[:cut].strip())
            p = p[cut:].strip()
        if p:
            chunks.append(p)

    groups, cur = [], ""
    for c in chunks:
        if not cur:
            cur = c
        elif len(cur) + 2 + len(c) <= maxlen:
            cur = cur + "\n\n" + c
        else:
            groups.append(cur)
            cur = c
    if cur:
        groups.append(cur)
    return groups


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--title", default="")
    ap.add_argument("--max", type=int, default=1400)
    ap.add_argument("--gap", type=float, default=2)
    args = ap.parse_args()

    if not os.path.exists(args.file):
        sys.exit("文件不存在: " + args.file)
    if not os.path.exists(PUSH_JS):
        sys.exit("找不到 wb-push.js: " + PUSH_JS)

    text = open(args.file, encoding="utf-8").read().strip()
    if not text:
        sys.exit("文件内容为空")

    lines = text.splitlines()
    title = args.title or (lines[0].strip() if lines else "WorkBuddy 通知")
    body = text
    if not args.title and lines:
        body = text[len(lines[0]):].strip() or text

    groups = split_text(body, args.max)
    total = len(groups)
    print(f"[wb-push-long] 共 {total} 段，长度 {[len(g) for g in groups]}")

    node = find_node()
    env = dict(os.environ)
    for i, g in enumerate(groups, 1):
        seg_title = f"{title} ({i}/{total})" if total > 1 else title
        proc = subprocess.run(
            [node, PUSH_JS, "--send", seg_title],
            input=g.encode("utf-8"),
            capture_output=True,
            env=env,
        )
        out = (proc.stdout + proc.stderr).decode("utf-8", "replace").strip()
        print(f"--- 第 {i}/{total} 段 rc={proc.returncode}\n{out}")
        if proc.returncode != 0:
            sys.exit(1)
        if i < total:
            time.sleep(args.gap)

    print("[wb-push-long] 全部发送完成")


if __name__ == "__main__":
    main()
