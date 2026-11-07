/**
 * meow-restart — client side (web GUI bundle).
 *
 * Loaded in the main app context via
 * dsh.client.inject = ["@deepseek-ai/dsh-client-ui-settings-plugins"] and the
 * window.__ModuleLoader__.load({ id, factory }) bundle format. Renders a small
 * floating ⟳ button that can be DRAGGED along the top strip (default top-left).
 * Clicking it opens a tiny two-item menu: 重启 (relaunch the whole app) and
 * 关闭 (force-quit it, no relaunch).
 *
 *   - Desktop (Electron) top strip is a drag region → the button AND the menu
 *     opt out via -webkit-app-region: no-drag so they stay clickable.
 *   - Browser tabs are fine too (position: fixed works the same).
 *
 * 重启 → POST /api/meow-restart/restart → the host arms a detached helper that
 * force-kills the whole app tree and relaunches the same exe → this window dies
 * with the app. In a plain browser (app died, page alive) the client polls
 * /api/meow-restart/ping and reloads once the host is back.
 * 关闭 → POST /api/meow-restart/quit → same helper minus the relaunch.
 *
 * Drag: press-and-move repositions the button along the top strip (y clamped to
 * the top 60px, x clamped to the viewport), persisted in localStorage
 * ("meow-restart-pos") and restored on load.
 */
window.__ModuleLoader__.load({
  id: "meow-restart",
  factory: (require) => {
    const inject = [];

    const BUTTON_ID = "meow-restart-btn";
    const MENU_ID = "meow-restart-menu";
    const ITEM_CLASS = "meow-restart-item";
    const OVERLAY_CLASS = "meow-restart-overlay";
    const BUSY_CLASS = "meow-restart-busy";
    const DRAG_CLASS = "meow-restart-dragging";
    const POS_KEY = "meow-restart-pos";

    const DRAG_TOP_MAX = 60; // keep the button inside the top strip
    const DRAG_THRESHOLD = 5; // px of movement before it counts as a drag
    const EDGE = 2;
    const MENU_W = 58;
    const MENU_H = 58;
    const BTN_SIZE = 22;

    const css = [
      "#" + BUTTON_ID + " {",
      "  position: fixed;",
      "  top: 4px;",
      "  left: 8px;",
      "  z-index: 2147483000;",
      "  width: " + BTN_SIZE + "px;",
      "  height: " + BTN_SIZE + "px;",
      "  padding: 0;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  border-radius: 7px;",
      "  border: 1px solid rgba(127, 127, 127, 0.35);",
      "  background: rgba(127, 127, 127, 0.16);",
      "  color: inherit;",
      "  font-size: 13px;",
      "  line-height: 1;",
      "  cursor: pointer;",
      "  user-select: none;",
      "  touch-action: none;",
      "  -webkit-app-region: no-drag;",
      "  app-region: no-drag;",
      "  opacity: 0.5;",
      "  transition: opacity 0.15s ease, background 0.15s ease, transform 0.4s ease;",
      "  backdrop-filter: blur(4px);",
      "}",
      "#" + BUTTON_ID + ":hover {",
      "  opacity: 1;",
      "  background: rgba(127, 127, 127, 0.32);",
      "  transform: rotate(90deg);",
      "}",
      "#" + BUTTON_ID + ":active {",
      "  transform: rotate(180deg) scale(0.92);",
      "}",
      "#" + BUTTON_ID + "." + DRAG_CLASS + " {",
      "  cursor: grabbing;",
      "  opacity: 1;",
      "  transition: opacity 0.15s ease, background 0.15s ease;",
      "  transform: none;",
      "}",
      "#" + BUTTON_ID + "." + BUSY_CLASS + " {",
      "  opacity: 1;",
      "  pointer-events: none;",
      "  animation: meow-restart-spin 0.9s linear infinite;",
      "}",
      "@keyframes meow-restart-spin {",
      "  to { transform: rotate(360deg); }",
      "}",
      "#" + MENU_ID + " {",
      "  position: fixed;",
      "  z-index: 2147483001;",
      "  width: " + MENU_W + "px;",
      "  padding: 3px;",
      "  display: flex;",
      "  flex-direction: column;",
      "  gap: 2px;",
      "  border-radius: 9px;",
      "  border: 1px solid rgba(127, 127, 127, 0.35);",
      "  background: rgba(127, 127, 127, 0.22);",
      "  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);",
      "  backdrop-filter: blur(10px);",
      "  -webkit-app-region: no-drag;",
      "  app-region: no-drag;",
      "  animation: meow-restart-pop 0.12s ease-out;",
      "}",
      "@keyframes meow-restart-pop {",
      "  from { opacity: 0; transform: translateY(-3px) scale(0.96); }",
      "  to { opacity: 1; transform: none; }",
      "}",
      "." + ITEM_CLASS + " {",
      "  height: 24px;",
      "  padding: 0;",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  border: 0;",
      "  border-radius: 6px;",
      "  background: transparent;",
      "  color: inherit;",
      "  font: 12px/1 system-ui, sans-serif;",
      "  cursor: pointer;",
      "  white-space: nowrap;",
      "}",
      "." + ITEM_CLASS + ":hover {",
      "  background: rgba(127, 127, 127, 0.4);",
      "}",
      "." + ITEM_CLASS + '[data-act="quit"]:hover {',
      "  background: rgba(217, 83, 79, 0.9);",
      "  color: #fff;",
      "}",
      "." + OVERLAY_CLASS + " {",
      "  position: fixed;",
      "  inset: 0;",
      "  z-index: 2147483600;",
      "  background: rgba(0, 0, 0, 0.5);",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  color: #fff;",
      "  font: 14px/1.7 system-ui, sans-serif;",
      "  text-align: center;",
      "  white-space: pre-wrap;",
      "}",
    ].join("\n");

    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

    let busy = false;
    let moved = false; // pointer dragged? guards the post-drag click event
    let drag = null; // { pointerId, startX, startY, origLeft, origTop, width }

    function menu() {
      return document.getElementById(MENU_ID);
    }

    function closeMenu() {
      const el = menu();
      if (el) el.remove();
    }

    function showOverlay(text) {
      const overlay = document.createElement("div");
      overlay.className = OVERLAY_CLASS;
      overlay.textContent = text;
      document.body.appendChild(overlay);
      return overlay;
    }

    function placeMenu(panel, btn) {
      const r = btn.getBoundingClientRect();
      const left = clamp(r.left, EDGE, window.innerWidth - MENU_W - EDGE);
      let top = r.bottom + 4;
      if (top + MENU_H > window.innerHeight - EDGE) {
        top = Math.max(EDGE, r.top - MENU_H - 4);
      }
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    }

    function triggerAction(kind) {
      if (busy) return;
      busy = true;
      closeMenu();
      const btn = document.getElementById(BUTTON_ID);
      btn?.classList.add(BUSY_CLASS);

      const restarting = kind === "restart";
      const overlay = showOverlay(restarting ? "正在重启 DSH…" : "正在关闭 DSH…");

      fetch("/api/meow-restart/" + kind, {
        method: "POST",
        headers: { "x-meow-restart": kind },
        cache: "no-store",
      })
        .then((res) => {
          if (!res.ok) throw new Error("HTTP " + res.status);
          if (restarting) {
            // The app is going down; on desktop this window dies with it. Only
            // poll when we might outlive the app (browser / remote view).
            pollUntilBackThenReload(overlay);
          } else {
            pollUntilGone(overlay);
          }
        })
        .catch((error) => {
          const what = restarting ? "重启" : "关闭";
          overlay.textContent = what + "失败：" + (error?.message ?? error);
          btn?.classList.remove(BUSY_CLASS);
          busy = false;
          setTimeout(() => overlay.remove(), 4000);
        });
    }

    // Restart: the host answers 200 first and only then lets the helper kill the
    // app (which waits ~1.2s before pulling the trigger). So an immediately
    // successful ping proves nothing — v0.2.x reloaded right there and the whole
    // restart looked like a no-op. A ping must FAIL once (sawDown) before a later
    // success can mean "it came back".
    function pollUntilBackThenReload(overlay) {
      const started = Date.now();
      let sawDown = false;
      const timer = setInterval(async () => {
        let up = false;
        try {
          const res = await fetch("/api/meow-restart/ping", { cache: "no-store" });
          up = res.ok;
        } catch {
          up = false;
        }
        const waited = Date.now() - started;

        if (up && sawDown) {
          clearInterval(timer);
          if (overlay) overlay.textContent = "重启完成，正在重新载入…";
          location.reload();
          return;
        }
        if (!up) sawDown = true;

        if (!sawDown && waited > 10000) {
          // Never went down: the kill did not land at all.
          clearInterval(timer);
          if (overlay) overlay.textContent = "重启没生效：DSH 还在运行，可以再点一次「重启」";
          const btn = document.getElementById(BUTTON_ID);
          btn?.classList.remove(BUSY_CLASS);
          busy = false;
          setTimeout(() => overlay?.remove(), 6000);
          return;
        }
        if (sawDown && waited > 40000) {
          // Went down but never came back: nothing left to poll for.
          clearInterval(timer);
          if (overlay) {
            overlay.textContent = "DSH 已关闭但没起来：请手动打开 DSH（这个页面连的是旧端口，重新打开后再操作）";
          }
        }
      }, 500);
    }

    // Quit: the kill normally lands within ~3s. Wait a short, honest window —
    // if the app is still answering after that, something went wrong and the
    // user should be told immediately instead of staring at a 30s spinner.
    function pollUntilGone(overlay) {
      const started = Date.now();
      const timer = setInterval(async () => {
        try {
          await fetch("/api/meow-restart/ping", { cache: "no-store" });
        } catch {
          clearInterval(timer);
          if (overlay) overlay.textContent = "DSH 已关闭，可以关掉这个页面了";
          return;
        }
        if (Date.now() - started > 8000) {
          clearInterval(timer);
          if (overlay) overlay.textContent = "关闭没生效：DSH 还在运行，可以再点一次「关闭」";
          const btn = document.getElementById(BUTTON_ID);
          btn?.classList.remove(BUSY_CLASS);
          busy = false;
          setTimeout(() => overlay?.remove(), 6000);
        }
      }, 500);
    }

    function toggleMenu(btn) {
      if (busy) return;
      if (menu()) {
        closeMenu();
        return;
      }
      const panel = document.createElement("div");
      panel.id = MENU_ID;

      const restart = document.createElement("button");
      restart.type = "button";
      restart.className = ITEM_CLASS;
      restart.dataset.act = "restart";
      restart.textContent = "重启";
      restart.title = "重启 DSH（关闭后自动重新打开）";
      restart.addEventListener("click", (e) => {
        e.stopPropagation();
        triggerAction("restart");
      });

      const quit = document.createElement("button");
      quit.type = "button";
      quit.className = ITEM_CLASS;
      quit.dataset.act = "quit";
      quit.textContent = "关闭";
      quit.title = "强制关闭 DSH（不会自动重新打开）";
      quit.addEventListener("click", (e) => {
        e.stopPropagation();
        triggerAction("quit");
      });

      panel.appendChild(restart);
      panel.appendChild(quit);
      document.body.appendChild(panel);
      placeMenu(panel, btn);
    }

    function restorePosition(btn) {
      try {
        const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          btn.style.left = clamp(saved.x, EDGE, window.innerWidth - BTN_SIZE - EDGE) + "px";
          btn.style.top = clamp(saved.y, EDGE, DRAG_TOP_MAX) + "px";
        }
      } catch {
        // broken stored value → keep the CSS default spot
      }
    }

    function apply() {
      if (typeof document === "undefined") return;
      if (document.getElementById(BUTTON_ID)) return; // idempotent

      const style = document.createElement("style");
      style.dataset.plugin = "meow-restart";
      style.textContent = css;
      document.head.appendChild(style);

      const btn = document.createElement("button");
      btn.id = BUTTON_ID;
      btn.type = "button";
      btn.title = "重启 / 关闭 DSH（点击打开菜单 · 按住可拖到顶部任意位置）";
      btn.setAttribute("aria-label", "重启或关闭 DSH");
      btn.textContent = "⟳";
      restorePosition(btn);
      document.body.appendChild(btn);

      btn.addEventListener("pointerdown", (e) => {
        if (busy || drag || e.button !== 0) return;
        closeMenu(); // a fresh gesture: never inherit an open menu
        const rect = btn.getBoundingClientRect();
        drag = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          origLeft: rect.left,
          origTop: rect.top,
          width: rect.width,
        };
        moved = false;
        try { btn.setPointerCapture(e.pointerId); } catch { /* old engine */ }
        btn.classList.add(DRAG_CLASS);
        e.preventDefault();
      });

      btn.addEventListener("pointermove", (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) moved = true;
        if (!moved) return;
        const left = clamp(drag.origLeft + dx, EDGE, window.innerWidth - drag.width - EDGE);
        const top = clamp(drag.origTop + dy, EDGE, DRAG_TOP_MAX);
        btn.style.left = left + "px";
        btn.style.top = top + "px";
      });

      const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        drag = null;
        btn.classList.remove(DRAG_CLASS);
        if (moved) {
          // persist the new spot; the following click event is swallowed
          setTimeout(() => { moved = false; }, 250);
          try {
            localStorage.setItem(
              POS_KEY,
              JSON.stringify({
                x: parseFloat(btn.style.left) || 0,
                y: parseFloat(btn.style.top) || 0,
              }),
            );
          } catch { /* storage unavailable → position just won't persist */ }
        }
      };
      btn.addEventListener("pointerup", endDrag);
      btn.addEventListener("pointercancel", (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        drag = null;
        moved = false;
        btn.classList.remove(DRAG_CLASS);
      });

      // click fires after pointerup (also for keyboard activation, where moved
      // stays false). A real drag releases on the same element, so the
      // post-drag click must be swallowed — the `moved` flag does that.
      btn.addEventListener("click", () => {
        if (moved) return;
        toggleMenu(btn);
      });

      // click anywhere else / press Esc → dismiss the menu
      document.addEventListener("pointerdown", (e) => {
        const panel = menu();
        if (!panel) return;
        const target = e.target;
        if (target === btn || btn.contains(target)) return;
        if (panel.contains(target)) return;
        closeMenu();
      }, true);
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMenu();
      });

      // keep the saved position inside the viewport when the window shrinks
      window.addEventListener("resize", () => {
        closeMenu();
        if (drag || busy) return;
        const left = parseFloat(btn.style.left);
        const top = parseFloat(btn.style.top);
        if (Number.isFinite(left)) {
          btn.style.left = clamp(left, EDGE, window.innerWidth - BTN_SIZE - EDGE) + "px";
        }
        if (Number.isFinite(top)) {
          btn.style.top = clamp(top, EDGE, DRAG_TOP_MAX) + "px";
        }
      });
    }

    return { inject, apply };
  },
});
