/**
 * dsh-restart-button — browser half.
 *
 * Hand-written ModuleLoader bundle (no build step): the host serves it from this
 * package's `exports["./client"]` and dsh-client-modules mounts it on the loader
 * row named `dsh-restart-button`.
 *
 * One registration only: `sidebar.brand.name`, the slot immediately right of the
 * "DeepSeek Harness" wordmark. The sidebar documents this slot as replaceable by
 * a deployment, and the sidebar's own 7 render targets leave no other free seat
 * (a second registration on any `single` slot throws), so the shipped occupant
 * `ui-brand-official` is disabled in the profile patch and this bundle re-renders
 * the official wordmark next to the button.
 *
 * A `sidebar.panellist` entry + details page existed in an earlier revision and
 * was removed: it duplicated this button.
 */
window.__ModuleLoader__.load({
	id: "dsh-restart-button",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;

		const NS = "dsh-restart-button";
		const BASE = "/dsh-restart-button";

		const zh = {
			label: "重启 DeepSeek Harness",
			restarting: "正在重启…",
			waiting: "已请求重启，正在等待新进程…",
			confirm: "确定要重启 DeepSeek Harness 吗？\n\n正在运行的任务会被中断。",
			failed: "触发重启失败，请重试。",
			unavailable: "重启不可用：",
			timedOut: "等待超时，请手动重新打开应用。",
		};
		const en = {
			label: "Restart DeepSeek Harness",
			restarting: "Restarting…",
			waiting: "Restart requested, waiting for the new process…",
			confirm: "Restart DeepSeek Harness?\n\nRunning tasks will be interrupted.",
			failed: "Could not trigger the restart. Try again.",
			unavailable: "Restart unavailable: ",
			timedOut: "Timed out. Please reopen the application manually.",
		};

		const CSS = [
			".dsrr-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.72;vertical-align:middle}",
			".dsrr-btn:hover{background:rgba(127,127,127,.18);opacity:1}",
			".dsrr-btn:focus-visible{outline:2px solid #4d6bfe;outline-offset:1px}",
			".dsrr-btn[data-state='busy']{opacity:1;cursor:progress}",
			".dsrr-btn[data-spin='true'] svg{animation:dsrr-spin 1s linear infinite}",
			"@keyframes dsrr-spin{to{transform:rotate(360deg)}}",
			".dsrr-brand{display:inline-flex;align-items:center;gap:2px;min-width:0}",
		].join("");

		/** Inject the stylesheet once per document. */
		function ensureCss() {
			if (typeof document === "undefined") return;
			const tagId = NS + "/client.css";
			if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		/** Poll until a different boot id answers, then reload the page. */
		async function waitForNewBoot(previousBootId, setPhase) {
			const deadline = Date.now() + 180000;
			while (Date.now() < deadline) {
				await sleep(700);
				try {
					const response = await fetch(BASE + "/health", { cache: "no-store" });
					if (!response.ok) continue;
					const body = await response.json();
					if (body && body.bootId && body.bootId !== previousBootId) {
						await sleep(700);
						window.location.reload();
						return;
					}
				} catch {
					/* the process is gone; keep waiting for it to come back */
				}
			}
			setPhase("timedOut");
		}

		/**
		 * Trigger one restart and wait for the replacement process.
		 * @param setPhase - phase setter.
		 * @param t - translator.
		 */
		async function triggerRestart(setPhase, t) {
			setPhase("starting");
			let previousBootId;
			try {
				const response = await fetch(BASE + "/restart", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				if (!response.ok) {
					let reason = "HTTP " + response.status;
					try {
						const body = await response.json();
						if (body && (body.reason || body.error)) reason = String(body.reason ?? body.error);
					} catch {
						/* keep the status code */
					}
					setPhase("idle");
					try {
						window.alert(t("unavailable") + reason);
					} catch {
						/* alert unavailable */
					}
					return;
				}
				const body = await response.json().catch(() => ({}));
				previousBootId = body && body.bootId;
			} catch (error) {
				setPhase("idle");
				try {
					window.alert(t("failed") + " " + String((error && error.message) || error));
				} catch {
					/* alert unavailable */
				}
				return;
			}
			setPhase("waiting");
			await waitForNewBoot(previousBootId, setPhase);
		}

		/** Busy phases share the spinning glyph. */
		function isBusy(phase) {
			return phase === "starting" || phase === "waiting";
		}

		/** The restart control. */
		function IconButton(props) {
			const t = props.t;
			const [phase, setPhase] = react.useState("idle");
			const busy = isBusy(phase);
			const label = busy ? t("restarting") : t("label");
			const title = phase === "waiting" ? t("waiting") : phase === "timedOut" ? t("timedOut") : label;

			return h(
				"button",
				{
					type: "button",
					className: "dsrr-btn",
					title,
					"aria-label": label,
					"data-state": busy ? "busy" : "idle",
					"data-spin": busy ? "true" : "false",
					// The expanded brand row is a New Session shortcut; keep our
					// clicks away from it.
					onMouseDown: (event) => event.stopPropagation(),
					onMouseUp: (event) => event.stopPropagation(),
					onClick: (event) => {
						event.preventDefault();
						event.stopPropagation();
						if (busy) return;
						let confirmed = true;
						try {
							confirmed = window.confirm(t("confirm"));
						} catch {
							confirmed = true;
						}
						if (!confirmed) return;
						void triggerRestart(setPhase, t);
					},
				},
				h(primitives.IconRefreshOutlineRegular, { size: 16 }),
			);
		}

		/** The brand-row occupant: the official wordmark followed by the button. */
		function BrandWithRestart(props) {
			const t = props.t;
			return h(
				"span",
				{ className: "dsrr-brand" },
				h(primitives.BrandWordmark, { includeMark: false }),
				h(IconButton, { t }),
			);
		}

		/** Build a translator for the registered dictionary. */
		function translator(ctx) {
			let bound;
			try {
				ctx.locale.register(NS, { zh, en });
				bound = ctx.locale.bind(NS);
			} catch {
				bound = undefined;
			}
			return (key) => {
				if (bound !== undefined) {
					try {
						const value = bound(key);
						if (typeof value === "string" && value !== "" && value !== key) return value;
					} catch {
						/* fall through to the local dictionary */
					}
				}
				return zh[key] ?? key;
			};
		}

		/** Client plugin body. */
		function apply(ctx) {
			ensureCss();
			const t = translator(ctx);
			try {
				ctx.slots.inject("sidebar.brand.name", () =>
					ctx.slots.register({ name: "sidebar.brand.name", locale: NS, inject: () => ({ t }) }, BrandWithRestart),
				);
			} catch (error) {
				console.warn("[dsh-restart-button] sidebar.brand.name registration failed", error);
			}
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		return module.exports;
	},
});
