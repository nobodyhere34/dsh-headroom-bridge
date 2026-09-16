window.__ModuleLoader__.load({
	id: "@nobodyhere34/dsh-headroom-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region src/client/card-form.ts
		/**
		* A whole-number field. An empty draft clears the field; any other draft that
		* is not a finite number blocks the save.
		* @param field - field name inside the namespace section.
		* @returns the field's conversion spec.
		*/
		function numberField(field) {
			return {
				field,
				format: (value) => typeof value === "number" ? String(value) : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const parsed = Number(trimmed);
					return Number.isFinite(parsed) ? {
						kind: "set",
						value: parsed
					} : void 0;
				}
			};
		}
		/**
		* A free-text field. An empty draft clears the field, so emptying the control
		* and saving is the same gesture as resetting it.
		* @param field - field name inside the namespace section.
		* @returns the field's conversion spec.
		*/
		function textField(field) {
			return {
				field,
				format: (value) => typeof value === "string" ? value : "",
				parse: (text) => {
					const trimmed = text.trim();
					return trimmed === "" ? { kind: "clear" } : {
						kind: "set",
						value: trimmed
					};
				}
			};
		}
		/**
		* A one-of-options field. An empty draft clears the field; any other draft
		* that is not one of the offered options blocks the save.
		* @param field - field name inside the namespace section.
		* @param options - the accepted option values.
		* @returns the field's conversion spec.
		*/
		function selectField(field, options) {
			return {
				field,
				format: (value) => typeof value === "string" ? value : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					return options.includes(trimmed) ? {
						kind: "set",
						value: trimmed
					} : void 0;
				}
			};
		}
		/**
		* A boolean field whose draft text is the literal 'true' / 'false'. An empty
		* draft clears the field; any other draft blocks the save.
		* @param field - field name inside the namespace section.
		* @returns the field's conversion spec.
		*/
		function boolField(field) {
			return {
				field,
				format: (value) => value === true ? "true" : value === false ? "false" : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					if (trimmed === "true") return {
						kind: "set",
						value: true
					};
					if (trimmed === "false") return {
						kind: "set",
						value: false
					};
				}
			};
		}
		/**
		* Stages one card's edits over one settings namespace and writes them on save.
		*
		* The form publishes through a snapshot store because slot components read
		* through a snapshot selector, while both the scope and the local drafts
		* change underneath; every projection is rebuilt from the two together.
		*/
		var CardForm = class {
			scope;
			specs;
			staged = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			saving = false;
			failed = false;
			/**
			* @param scope - the bound settings scope for this card's namespace.
			* @param specs - the section fields this card edits.
			*/
			constructor(scope, specs) {
				this.scope = scope;
				this.specs = new Map(specs.map((spec) => [spec.field, spec]));
				scope.subscribe(() => {
					this.publish();
				});
			}
			/**
			* Publish a projection of this form, rebuilt whenever the scope or a draft changes.
			* @param project - build the card's state from the form's current reads.
			* @returns the store the card's component reads through its bound selector.
			*/
			bind(project) {
				const store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(project());
				this.listeners.add(() => {
					store.set(project());
				});
				return store;
			}
			/**
			* Read the card-level state: what the Host serves, and what a save would do.
			* @returns the form state every card shares.
			*/
			shell() {
				const snapshot = this.scope.getSnapshot();
				const plan = this.plan();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					dirty: plan.length > 0,
					invalid: plan.some((item) => item.run === void 0),
					saving: this.saving,
					failed: this.failed
				};
			}
			/**
			* Read one control's state.
			* @param field - field name of a section field.
			* @returns the draft text, whether a save would leave an override, and whether it is invalid.
			*/
			field(field) {
				const staged = this.staged.get(field);
				const spec = this.spec(field);
				if (staged === void 0) return {
					text: spec.format(this.sectionValue(field)),
					overridden: this.stored(field),
					invalid: false
				};
				const write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
				return {
					text: staged.text,
					overridden: write?.kind === "set",
					invalid: write === void 0
				};
			}
			/**
			* Build the edit, reset, save, and discard actions bound to this form.
			* @returns the actions a card's slot entry injects.
			*/
			actions() {
				return {
					edit: (field, text) => {
						this.stage(field, {
							text,
							clear: false
						});
					},
					resetField: (field) => {
						this.stage(field, {
							text: this.spec(field).format(this.baseValue(field)),
							clear: true
						});
					},
					save: () => {
						this.save();
					},
					discard: () => {
						if (this.staged.size === 0 && !this.failed) return;
						this.staged.clear();
						this.failed = false;
						this.publish();
					}
				};
			}
			/**
			* Write every staged edit, then re-seed from what the Host accepted.
			*
			* The Host is the only authority on whether a value was accepted — its
			* validators own the constraints no schema can express — so the outcome is
			* read back from the section rather than predicted here. A save that did not
			* land keeps its drafts, so the user can correct them instead of retyping.
			* @returns settlement after every write and the read-back.
			*/
			async save() {
				const plan = this.plan();
				const writes = plan.flatMap((item) => item.run === void 0 ? [] : [item.run]);
				if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				let landed = true;
				for (const write of writes) landed = await write() && landed;
				if (landed) this.staged.clear();
				this.saving = false;
				this.failed = !landed;
				this.publish();
			}
			/**
			* Every staged edit a save would write. An entry whose draft is not a value
			* its field accepts carries no write: the form is still dirty, and the save
			* refuses rather than dropping the edit.
			* @returns the planned writes, in the order the fields were staged.
			*/
			plan() {
				const plan = [];
				for (const [field, staged] of this.staged) {
					const spec = this.spec(field);
					if (staged.clear) {
						if (this.stored(field)) plan.push({
							field,
							run: () => this.clear(field)
						});
						continue;
					}
					if (staged.text === spec.format(this.sectionValue(field))) continue;
					const write = spec.parse(staged.text);
					if (write === void 0) plan.push({
						field,
						run: void 0
					});
					else if (write.kind === "clear") plan.push({
						field,
						run: () => this.clear(field)
					});
					else plan.push({
						field,
						run: () => this.store(field, write.value)
					});
				}
				return plan;
			}
			async clear(field) {
				await this.scope.unset(field);
				return !this.stored(field);
			}
			async store(field, value) {
				await this.scope.set(field, value);
				return this.userLayer()?.[field] === value;
			}
			stage(field, edit) {
				this.staged.set(field, edit);
				this.failed = false;
				this.publish();
			}
			spec(field) {
				const spec = this.specs.get(field);
				if (spec === void 0) throw new Error(`plugin card has no field ${field}`);
				return spec;
			}
			snapshotOf() {
				return this.scope.getSnapshot();
			}
			sectionValue(field) {
				return this.snapshotOf().value?.[field];
			}
			baseValue(field) {
				return this.snapshotOf().base?.[field];
			}
			userLayer() {
				return this.snapshotOf().user;
			}
			stored(field) {
				const user = this.userLayer();
				return user !== void 0 && Object.hasOwn(user, field);
			}
			publish() {
				for (const listener of this.listeners) listener();
			}
		};
		//#endregion
		//#region src/client/headroom-card-controller.ts
		/** Settings namespace of the bridge, matching the Host's registration. */
		const HEADROOM_NS = "headroom";
		/** Bridges the 'headroom' scope onto the card's staged form. */
		var HeadroomCardController = class {
			openSession;
			form;
			store;
			/**
			* @param scope - the bound settings scope for the 'headroom' namespace.
			* @param openSession - workspace navigation to a session (optionally focused on a tool call), for activity-row deep links.
			*/
			constructor(scope, openSession) {
				this.openSession = openSession;
				this.form = new CardForm(scope, [
					selectField("mode", ["audit", "live"]),
					boolField("enabled"),
					textField("baseUrl"),
					numberField("timeoutMs"),
					numberField("minChars"),
					numberField("minSavingsRatio"),
					boolField("protectErrorOutputs")
				]);
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				return {
					...this.form.shell(),
					mode: this.form.field("mode"),
					enabled: this.form.field("enabled"),
					baseUrl: this.form.field("baseUrl"),
					timeoutMs: this.form.field("timeoutMs"),
					minChars: this.form.field("minChars"),
					minSavingsRatio: this.form.field("minSavingsRatio"),
					protectErrorOutputs: this.form.field("protectErrorOutputs")
				};
			}
			/**
			* Build the face the card's slot registration injects.
			* @returns the card's snapshot and its form actions.
			*/
			inject() {
				return {
					hooks: { headroomCard: this.store },
					...this.openSession === void 0 ? {} : { openSession: this.openSession },
					...this.form.actions()
				};
			}
		};
		//#endregion
		//#region \0dsh-css:/media/ict/19BD52556106DE5A/dsh-headroom-bridge/src/client/fields.module.css.mjs
		const css$3 = ".cJn9_W_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.cJn9_W_field+.cJn9_W_field{border-top:1px solid var(--dsw-alias-border-l2)}.cJn9_W_head{align-items:center;gap:8px;display:flex}.cJn9_W_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.cJn9_W_badges{align-items:center;gap:8px;display:inline-flex}.cJn9_W_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.cJn9_W_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}.cJn9_W_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.cJn9_W_reset:disabled{cursor:default}.cJn9_W_input,.cJn9_W_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}.cJn9_W_input:focus-visible,.cJn9_W_select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.cJn9_W_input:disabled,.cJn9_W_select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.cJn9_W_inputInvalid{border-color:var(--dsw-alias-label-error);}.cJn9_W_selectInvalid{border-color:var(--dsw-alias-label-error);}.cJn9_W_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.cJn9_W_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.cJn9_W_switch{box-sizing:border-box;background:var(--dsw-alias-border-l3);cursor:pointer;border:0;border-radius:10px;flex:none;width:36px;height:20px;padding:2px;position:relative}.cJn9_W_switchOn{background:var(--dsw-alias-brand-primary)}.cJn9_W_switch:disabled{cursor:default;opacity:.5}.cJn9_W_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.cJn9_W_thumb{background:var(--dsw-alias-label-primary-foreground);border-radius:50%;width:16px;height:16px;transition:transform .12s;display:block}.cJn9_W_switchOn .cJn9_W_thumb{transform:translate(16px)}";
		const tagId$3 = "@nobodyhere34/dsh-headroom-bridge/fields.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@nobodyhere34/dsh-headroom-bridge";
			tag.dataset.pluginCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		var fields_module_css_default = {
			"badge": "cJn9_W_badge",
			"badges": "cJn9_W_badges",
			"field": "cJn9_W_field",
			"head": "cJn9_W_head",
			"hint": "cJn9_W_hint",
			"input": "cJn9_W_input",
			"inputInvalid": "cJn9_W_inputInvalid",
			"invalid": "cJn9_W_invalid",
			"label": "cJn9_W_label",
			"reset": "cJn9_W_reset",
			"select": "cJn9_W_select",
			"selectInvalid": "cJn9_W_selectInvalid",
			"switch": "cJn9_W_switch",
			"switchOn": "cJn9_W_switchOn",
			"thumb": "cJn9_W_thumb"
		};
		//#endregion
		//#region src/client/fields.tsx
		/**
		* Hand-written controls for the headroom card's configuration form. Each
		* renders one field's label, its staged text, whether saving would leave an
		* override, and — when one stands — the reset that stages a clear back to the
		* composition layer. Nothing here writes: a control reports what the user
		* typed, and the card's save is the single point where a draft becomes a
		* document mutation. The value/select/switch control trio mirrors the controls
		* the Plugins section ships for its own cards, so a card contributed from
		* outside that package reads the same.
		*/
		/**
		* A staged value field. 'numeric' only hints the keypad: which drafts a field
		* accepts is decided by its spec, so the control never silently rewrites what
		* the user typed.
		* @param props - the field's copy, its staged text, and the edit actions.
		* @returns the labelled control.
		*/
		function ValueField(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: fields_module_css_default.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: fields_module_css_default.head,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: fields_module_css_default.label,
							htmlFor: props.id,
							children: props.label
						}), props.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: fields_module_css_default.badges,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: fields_module_css_default.badge,
								children: props.overriddenLabel
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: fields_module_css_default.reset,
								disabled: props.disabled,
								onClick: props.onReset,
								children: props.resetLabel
							})]
						}) : null]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: props.id,
						className: props.invalid ? fields_module_css_default.inputInvalid : fields_module_css_default.input,
						type: "text",
						...props.numeric === true ? { inputMode: "numeric" } : {},
						...props.invalid ? { "aria-invalid": true } : {},
						value: props.text,
						placeholder: props.placeholder ?? "",
						disabled: props.disabled,
						onChange: (event) => {
							props.onEdit(event.target.value);
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: props.invalid ? fields_module_css_default.invalid : fields_module_css_default.hint,
						children: props.invalid ? props.invalidLabel : props.hint
					})
				]
			});
		}
		/**
		* A staged one-of-options control. An empty draft renders the first option
		* (a select must show a concrete value) but stages nothing, so saving an
		* untouched field writes nothing.
		* @param props - the field's copy, its staged text, and the edit actions.
		* @returns the labelled control.
		*/
		function SelectField(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: fields_module_css_default.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: fields_module_css_default.head,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: fields_module_css_default.label,
							htmlFor: props.id,
							children: props.label
						}), props.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: fields_module_css_default.badges,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: fields_module_css_default.badge,
								children: props.overriddenLabel
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: fields_module_css_default.reset,
								disabled: props.disabled,
								onClick: props.onReset,
								children: props.resetLabel
							})]
						}) : null]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
						id: props.id,
						className: props.invalid ? fields_module_css_default.selectInvalid : fields_module_css_default.select,
						...props.invalid ? { "aria-invalid": true } : {},
						value: props.text === "" ? props.options[0] ?? "" : props.text,
						disabled: props.disabled,
						onChange: (event) => {
							props.onEdit(event.target.value);
						},
						children: props.options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: option,
							children: option
						}, option))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: props.invalid ? fields_module_css_default.invalid : fields_module_css_default.hint,
						children: props.invalid ? props.invalidLabel : props.hint
					})
				]
			});
		}
		/**
		* A staged boolean control rendered as a switch. The switch shows the staged
		* draft ('true' / 'false'); an empty draft renders off without staging
		* anything.
		* @param props - the field's copy, its on/off state, and the edit actions.
		* @returns the labelled control.
		*/
		function SwitchField(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: fields_module_css_default.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: fields_module_css_default.head,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: fields_module_css_default.label,
							htmlFor: props.id,
							children: props.label
						}), props.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: fields_module_css_default.badges,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: fields_module_css_default.badge,
								children: props.overriddenLabel
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: fields_module_css_default.reset,
								disabled: props.disabled,
								onClick: props.onReset,
								children: props.resetLabel
							})]
						}) : null]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						id: props.id,
						type: "button",
						role: "switch",
						"aria-checked": props.on,
						className: props.on ? `${fields_module_css_default.switch} ${fields_module_css_default.switchOn}` : fields_module_css_default.switch,
						disabled: props.disabled,
						onClick: () => {
							props.onEdit(!props.on);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: fields_module_css_default.thumb })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: fields_module_css_default.hint,
						children: props.hint
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:/media/ict/19BD52556106DE5A/dsh-headroom-bridge/src/client/PluginCard.module.css.mjs
		const css$2 = "._3DyMTq_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}._3DyMTq_card:hover{border-color:var(--dsw-alias-label-dimmed)}._3DyMTq_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}._3DyMTq_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}._3DyMTq_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}._3DyMTq_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}._3DyMTq_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}._3DyMTq_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}._3DyMTq_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}._3DyMTq_chevronOpen{transform:rotate(180deg)}._3DyMTq_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}._3DyMTq_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}._3DyMTq_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}._3DyMTq_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}._3DyMTq_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}._3DyMTq_discard,._3DyMTq_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}._3DyMTq_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}._3DyMTq_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}._3DyMTq_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}._3DyMTq_discard:disabled,._3DyMTq_save:disabled{opacity:.4;cursor:default}._3DyMTq_discard:focus-visible,._3DyMTq_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}";
		const tagId$2 = "@nobodyhere34/dsh-headroom-bridge/PluginCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@nobodyhere34/dsh-headroom-bridge";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var PluginCard_module_css_default = {
			"body": "_3DyMTq_body",
			"card": "_3DyMTq_card",
			"cardOpen": "_3DyMTq_cardOpen",
			"chevron": "_3DyMTq_chevron",
			"chevronOpen": "_3DyMTq_chevronOpen",
			"description": "_3DyMTq_description",
			"discard": "_3DyMTq_discard",
			"failed": "_3DyMTq_failed",
			"footer": "_3DyMTq_footer",
			"headText": "_3DyMTq_headText",
			"header": "_3DyMTq_header",
			"name": "_3DyMTq_name",
			"pending": "_3DyMTq_pending",
			"readOnly": "_3DyMTq_readOnly",
			"save": "_3DyMTq_save"
		};
		//#endregion
		//#region src/client/PluginCard.tsx
		/**
		* The headroom card's chrome — the same disclosure card the Plugins section
		* ships for its own cards: a header naming the plugin and what its settings
		* govern, disclosing the controls in place, with the save that writes them.
		*
		* The header is its own button rather than a shared disclosure row because a
		* card stacks its name over its description, while that row lays the two side
		* by side — the layout, not the behavior, is what differs. Disclosure is
		* card-local state: which card a user has open is a reading gesture, not
		* something the Host or the section has any stake in. Staged edits outlive
		* collapsing, so the header marks a card holding unsaved edits.
		*
		* A card renders nothing while its namespace is unavailable: a deployment that
		* does not compose the owning plugin should show no trace of it, rather than a
		* disabled card the user cannot act on.
		*/
		/**
		* Render the card.
		* @param props - the card's copy keys, its form state, and its controls.
		* @returns the card, or nothing when the namespace is unavailable.
		*/
		function PluginCard(props) {
			const [open, setOpen] = (0, react.useState)(false);
			const { state } = props;
			if (!state.available) return null;
			const title = props.t(props.titleKey);
			const blocked = !state.dirty || state.invalid || state.saving;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: open ? `${PluginCard_module_css_default.card} ${PluginCard_module_css_default.cardOpen}` : PluginCard_module_css_default.card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: PluginCard_module_css_default.header,
					"aria-expanded": open,
					"aria-label": `${props.t(open ? "collapse" : "expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: PluginCard_module_css_default.headText,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: PluginCard_module_css_default.name,
								children: title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: PluginCard_module_css_default.description,
								children: props.t(props.descriptionKey)
							})]
						}),
						state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: PluginCard_module_css_default.pending,
							children: props.t("unsaved")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: open ? `${PluginCard_module_css_default.chevron} ${PluginCard_module_css_default.chevronOpen}` : PluginCard_module_css_default.chevron })
					]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: PluginCard_module_css_default.body,
					children: [
						!state.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: PluginCard_module_css_default.readOnly,
							role: "status",
							children: props.t("readOnly")
						}) : null,
						props.children,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: PluginCard_module_css_default.footer,
							children: [
								state.failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: PluginCard_module_css_default.failed,
									role: "status",
									children: props.t("saveFailed")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: PluginCard_module_css_default.discard,
									disabled: !state.dirty || state.saving,
									onClick: props.onDiscard,
									children: props.t("discard")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: PluginCard_module_css_default.save,
									disabled: blocked,
									onClick: props.onSave,
									children: props.t(state.saving ? "saving" : "save")
								})
							]
						})
					]
				}) : null]
			});
		}
		//#endregion
		//#region \0dsh-css:/media/ict/19BD52556106DE5A/dsh-headroom-bridge/src/client/HeadroomCard.module.css.mjs
		const css$1 = ".xfW8HW_ledger{border-top:1px solid var(--dsw-alias-border-l2)}.xfW8HW_block{gap:8px;padding:12px 0;display:grid}.xfW8HW_blockTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;font-weight:600;line-height:1.5}.xfW8HW_statRow{justify-content:space-between;align-items:baseline;gap:16px;font-size:12px;line-height:1.5;display:flex}.xfW8HW_statLabel{color:var(--dsw-alias-label-secondary);flex:none}.xfW8HW_statValue{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow:hidden}.xfW8HW_statNote{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.xfW8HW_statError{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.xfW8HW_ledgerRow{color:var(--dsw-alias-label-secondary);flex-direction:column;gap:2px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;display:flex}.xfW8HW_ledgerHead{width:100%;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:4px;justify-content:space-between;align-items:baseline;gap:12px;margin:0;padding:1px 2px;display:flex}.xfW8HW_ledgerHead:disabled{cursor:default;opacity:.75}.xfW8HW_ledgerHead:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}.xfW8HW_pre{background:var(--dsw-alias-interactive-bg-hover);white-space:pre-wrap;word-break:break-word;max-height:200px;color:var(--dsw-alias-label-primary);border-radius:6px;margin:2px 0 6px;padding:6px 8px;font-size:11px;line-height:1.5;overflow:auto}.xfW8HW_ledgerHash{color:var(--dsw-alias-label-tertiary);flex:none}.xfW8HW_sessionLink{color:var(--dsw-alias-accent);cursor:pointer;flex:none;padding:0 4px}.xfW8HW_sessionLink:hover{text-decoration:underline}";
		const tagId$1 = "@nobodyhere34/dsh-headroom-bridge/HeadroomCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@nobodyhere34/dsh-headroom-bridge";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var HeadroomCard_module_css_default = {
			"block": "xfW8HW_block",
			"blockTitle": "xfW8HW_blockTitle",
			"ledger": "xfW8HW_ledger",
			"ledgerHash": "xfW8HW_ledgerHash",
			"ledgerHead": "xfW8HW_ledgerHead",
			"ledgerRow": "xfW8HW_ledgerRow",
			"pre": "xfW8HW_pre",
			"sessionLink": "xfW8HW_sessionLink",
			"statError": "xfW8HW_statError",
			"statLabel": "xfW8HW_statLabel",
			"statNote": "xfW8HW_statNote",
			"statRow": "xfW8HW_statRow",
			"statValue": "xfW8HW_statValue"
		};
		//#endregion
		//#region src/client/HeadroomCard.tsx
		/**
		* The headroom bridge's settings card: the configurable-plugins card under
		* the 'headroom' namespace. It stages the hot bridge fields (mode, enabled,
		* proxy endpoint, budgets, and failed-result protection) through the same
		* PluginCard + staged-form machinery the shipped Shell / Agent loop / Web
		* search cards use, and shows live bridge stats and the recent compression
		* ledger fetched from the Host's /headroom-bridge/api routes.
		*/
		/** Expandable original-text body for one activity row. */
		function OriginalBody({ hash }) {
			const [payload, setPayload] = (0, react.useState)("loading");
			(0, react.useEffect)(() => {
				let alive = true;
				fetch("/headroom-bridge/api/ledger/entry?hash=" + encodeURIComponent(hash)).then((res) => res.json()).then((d) => {
					if (alive) setPayload(d);
				}).catch(() => {
					if (alive) setPayload({ ok: false });
				});
				return () => {
					alive = false;
				};
			}, [hash]);
			if (payload === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: HeadroomCard_module_css_default.statNote,
				children: "…"
			});
			if (payload === null || !payload.ok) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: HeadroomCard_module_css_default.statNote,
				children: payload?.error === "original expired" ? "（原文已出窗降级，仅保留元数据）" : "（原文不可用）"
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
				className: HeadroomCard_module_css_default.pre,
				children: payload.originalText
			});
		}
		/** Live bridge stats + proxy health block. */
		function StatsSection({ t }) {
			const [stats, setStats] = (0, react.useState)(null);
			const [healthy, setHealthy] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [unreachable, setUnreachable] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				let alive = true;
				fetch("/headroom-bridge/api/stats").then((res) => res.json()).then((d) => {
					if (!alive) return;
					setStats(d);
					setError(d.ok ? null : String(d.error));
				}).catch(() => {
					if (alive) setUnreachable(true);
				});
				fetch("/headroom-bridge/api/health").then((res) => res.json()).then((d) => {
					if (alive && d.ok) setHealthy(d.healthy ?? null);
				}).catch(() => {});
				return () => {
					alive = false;
				};
			}, []);
			const rows = stats === null ? [] : [
				{
					label: t("statsMode"),
					value: stats.mode ?? ""
				},
				{
					label: t("statsEnabled"),
					value: String(stats.enabled ?? "")
				},
				{
					label: t("statsProxy"),
					value: stats.baseUrl ?? ""
				},
				{
					label: t("statsAttemptsFailures"),
					value: String(stats.counters?.attempts ?? 0) + " / " + String(stats.counters?.failures ?? 0)
				},
				{
					label: t("statsAdopted"),
					value: String(stats.counters?.adopted ?? 0)
				},
				{
					label: t("statsSavedChars"),
					value: String(stats.counters?.savedChars ?? 0)
				},
				{
					label: t("statsLedgerEntries"),
					value: String(stats.ledger?.entries ?? 0)
				},
				{
					label: t("statsHealth"),
					value: healthy === null ? t("healthUnknown") : String(healthy)
				}
			];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: HeadroomCard_module_css_default.block,
				"aria-label": t("statusTitle"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					className: HeadroomCard_module_css_default.blockTitle,
					children: t("statusTitle")
				}), unreachable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: HeadroomCard_module_css_default.statError,
					role: "status",
					children: t("statsUnreachable")
				}) : error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: HeadroomCard_module_css_default.statError,
					role: "status",
					children: t("statsFailed", { message: error })
				}) : stats === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: HeadroomCard_module_css_default.statNote,
					children: t("statsLoading")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: HeadroomCard_module_css_default.statRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: HeadroomCard_module_css_default.statLabel,
						children: row.label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: HeadroomCard_module_css_default.statValue,
						children: row.value
					})]
				}, row.label)) })]
			});
		}
		/** Recent operations: merged ledger + audit stream with expandable originals. */
		function LedgerSection({ t, openSession }) {
			const [rows, setRows] = (0, react.useState)(null);
			const [openHash, setOpenHash] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let alive = true;
				fetch("/headroom-bridge/api/ledger/activity?limit=20").then((res) => res.json()).then((d) => {
					if (alive && d.ok && Array.isArray(d.rows)) setRows(d.rows);
				}).catch(() => {});
				return () => {
					alive = false;
				};
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: `${HeadroomCard_module_css_default.block} ${HeadroomCard_module_css_default.ledger}`,
				"aria-label": t("ledgerActivity"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					className: HeadroomCard_module_css_default.blockTitle,
					children: t("ledgerActivity")
				}), rows === null ? null : rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: HeadroomCard_module_css_default.statNote,
					children: t("ledgerEmpty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: rows.map((row, i) => {
					const saved = row.charsBefore - row.charsAfter;
					const pct = row.charsBefore > 0 ? Math.round(saved / row.charsBefore * 100) : 0;
					const key = row.hash !== "" ? row.hash : row.kind + String(row.ts) + String(i);
					const clickable = row.kind === "ledger" && row.originalAvailable;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: HeadroomCard_module_css_default.ledgerRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: HeadroomCard_module_css_default.ledgerHead,
							disabled: !clickable,
							onClick: () => setOpenHash(openHash === key ? null : key),
							"aria-expanded": openHash === key,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: HeadroomCard_module_css_default.ledgerHash,
									children: row.kind === "ledger" ? row.hash.slice(0, 10) : row.state
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: row.toolName }),
								row.strategy !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									title: row.strategy,
									children: row.strategy.split(">").map((s) => s.split(":")[0] ?? s).join("›")
								}),
								row.kind === "ledger" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: `${String(row.charsBefore)}->${String(row.charsAfter)} (-${String(pct)}%)` }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									title: row.reason,
									children: row.state === "not-adopted" ? `-${String(pct)}% ${row.reason}` : row.state
								}),
								openSession !== void 0 && row.sessionId !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									role: "link",
									tabIndex: 0,
									className: HeadroomCard_module_css_default.sessionLink,
									title: row.sessionId,
									onClick: (e) => {
										e.stopPropagation();
										openSession(row.sessionId, row.callId);
									},
									onKeyDown: (e) => {
										if (e.key === "Enter") {
											e.stopPropagation();
											openSession(row.sessionId, row.callId);
										}
									},
									children: "↗"
								})
							]
						}), openHash === key && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(OriginalBody, { hash: row.hash })]
					}, key);
				}) })]
			});
		}
		/**
		* Render the headroom card: the standard disclosure card, with its controls
		* under the header and a save/discard footer, exactly like the shipped cards.
		* @param props - locale copy, the card snapshot, and its form actions.
		* @returns the card, or nothing when the namespace is unavailable.
		*/
		function HeadroomCard(props) {
			const { t } = props;
			const state = props.useHeadroomCard((snapshot) => snapshot);
			const disabled = !state.writable;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(PluginCard, {
				t,
				titleKey: "headroomTitle",
				descriptionKey: "headroomDescription",
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatsSection, { t }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SelectField, {
						id: "plugin-config-headroom-mode",
						label: t("mode"),
						hint: t("modeHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidValue"),
						options: ["audit", "live"],
						disabled,
						...state.mode,
						onEdit: (text) => {
							props.edit("mode", text);
						},
						onReset: () => {
							props.resetField("mode");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchField, {
						id: "plugin-config-headroom-enabled",
						label: t("enabled"),
						hint: t("enabledHint"),
						overridden: state.enabled.overridden,
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						disabled,
						on: state.enabled.text === "true",
						onEdit: (on) => {
							props.edit("enabled", on ? "true" : "false");
						},
						onReset: () => {
							props.resetField("enabled");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ValueField, {
						id: "plugin-config-headroom-base-url",
						label: t("baseUrl"),
						hint: t("baseUrlHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidNumber"),
						disabled,
						...state.baseUrl,
						onEdit: (text) => {
							props.edit("baseUrl", text);
						},
						onReset: () => {
							props.resetField("baseUrl");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ValueField, {
						id: "plugin-config-headroom-timeout",
						label: t("timeoutMs"),
						hint: t("timeoutMsHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidNumber"),
						numeric: true,
						disabled,
						...state.timeoutMs,
						onEdit: (text) => {
							props.edit("timeoutMs", text);
						},
						onReset: () => {
							props.resetField("timeoutMs");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ValueField, {
						id: "plugin-config-headroom-min-chars",
						label: t("minChars"),
						hint: t("minCharsHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidNumber"),
						numeric: true,
						disabled,
						...state.minChars,
						onEdit: (text) => {
							props.edit("minChars", text);
						},
						onReset: () => {
							props.resetField("minChars");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ValueField, {
						id: "plugin-config-headroom-ratio",
						label: t("minSavingsRatio"),
						hint: t("minSavingsRatioHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidNumber"),
						numeric: true,
						disabled,
						...state.minSavingsRatio,
						onEdit: (text) => {
							props.edit("minSavingsRatio", text);
						},
						onReset: () => {
							props.resetField("minSavingsRatio");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchField, {
						id: "plugin-config-headroom-protect-errors",
						label: t("protectErrorOutputs"),
						hint: t("protectErrorOutputsHint"),
						overridden: state.protectErrorOutputs.overridden,
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						disabled,
						on: state.protectErrorOutputs.text === "true",
						onEdit: (on) => {
							props.edit("protectErrorOutputs", on ? "true" : "false");
						},
						onReset: () => {
							props.resetField("protectErrorOutputs");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LedgerSection, {
						t,
						openSession: props.openSession
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:/media/ict/19BD52556106DE5A/dsh-headroom-bridge/src/client/CompressChip.module.css.mjs
		const css = ".VpC_6W_root{color:var(--dsw-alias-label-primary,#111827);background:#22c55e1f;border-radius:8px;margin:4px 0 8px;font-size:12px;line-height:1.5;overflow:hidden}.VpC_6W_head{width:100%;color:inherit;cursor:pointer;text-align:left;background:0 0;border:none;align-items:baseline;gap:8px;padding:6px 10px;font-size:12px;line-height:1.5;display:flex}.VpC_6W_head:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f0f)}.VpC_6W_badge{color:var(--dsw-alias-label-tertiary,#9ca3af);flex:none;font-size:12px}.VpC_6W_caret{color:var(--dsw-alias-label-tertiary,#9ca3af);margin-left:auto}.VpC_6W_row{border-top:1px solid var(--dsw-alias-line-border,#7f7f7f24)}.VpC_6W_rowHead{width:100%;color:inherit;cursor:pointer;text-align:left;background:0 0;border:none;align-items:baseline;gap:8px;padding:6px 10px;font-size:12px;line-height:1.5;display:flex}.VpC_6W_rowHead:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14)}.VpC_6W_rowTool{flex:none;min-width:72px;font-weight:600}.VpC_6W_rowType{min-width:0;color:var(--dsw-alias-label-secondary,#4b5563);text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}.VpC_6W_rowSize{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#4b5563);flex:none}.VpC_6W_rowCaret{color:var(--dsw-alias-label-tertiary,#9ca3af);flex:none}.VpC_6W_rowBody{padding:4px 10px 8px}.VpC_6W_note{color:var(--dsw-alias-label-secondary,#4b5563);margin:4px 0}.VpC_6W_pre{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14);white-space:pre-wrap;word-break:break-word;max-height:220px;color:var(--dsw-alias-label-primary,#111827);border-radius:6px;margin:4px 0;padding:6px 8px;font-size:11px;line-height:1.5;overflow:auto}.VpC_6W_meta{color:var(--dsw-alias-label-tertiary,#9ca3af);margin:4px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5}";
		const tagId = "@nobodyhere34/dsh-headroom-bridge/CompressChip.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@nobodyhere34/dsh-headroom-bridge";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var CompressChip_module_css_default = {
			"badge": "VpC_6W_badge",
			"caret": "VpC_6W_caret",
			"head": "VpC_6W_head",
			"meta": "VpC_6W_meta",
			"note": "VpC_6W_note",
			"pre": "VpC_6W_pre",
			"root": "VpC_6W_root",
			"row": "VpC_6W_row",
			"rowBody": "VpC_6W_rowBody",
			"rowCaret": "VpC_6W_rowCaret",
			"rowHead": "VpC_6W_rowHead",
			"rowSize": "VpC_6W_rowSize",
			"rowTool": "VpC_6W_rowTool",
			"rowType": "VpC_6W_rowType"
		};
		//#endregion
		//#region src/client/CompressChip.tsx
		/**
		* Trajectory compression chip: a turn-tail chain entry elected by the
		* headroom turn-data projection (headroom-turn.ts). It shows what the bridge
		* compressed inside one closed turn - per-result compression type (the
		* proxy's transforms chain, fetched lazily), before→after accounting, and an
		* expandable view of the exact original text from the ledger (the compressed
		* form is the tool row above in the transcript). Demoted originals render an
		* expired note instead: retrieval demand lives inside the context window,
		* the metadata stays honest about the rest.
		*/
		const API$1 = "/headroom-bridge/api";
		function fmt(n) {
			return n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
		}
		/** One expandable result row: type, accounting, and the original compare. */
		function ChipRow({ hit, t }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [payload, setPayload] = (0, react.useState)("loading");
			(0, react.useEffect)(() => {
				if (!open) return;
				let alive = true;
				fetch(`${API$1}/ledger/entry?hash=${encodeURIComponent(hit.hash)}`).then((res) => res.json().then((d) => ({
					status: res.status,
					d
				}))).then(({ d }) => {
					if (alive) setPayload(d);
				}).catch(() => {
					if (alive) setPayload({ ok: false });
				});
				return () => {
					alive = false;
				};
			}, [open, hit.hash]);
			const pct = hit.charsBefore > 0 ? Math.round((1 - hit.charsAfter / hit.charsBefore) * 100) : 0;
			const typeChain = (payload?.meta?.strategy ?? "").split(">").filter((s) => s.length > 0).map((s) => s.split(":").slice(0, 2).join(":")).join(" › ");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: CompressChip_module_css_default.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: CompressChip_module_css_default.rowHead,
					onClick: () => setOpen((v) => !v),
					"aria-expanded": open,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: CompressChip_module_css_default.rowTool,
							children: hit.toolName || hit.callId.slice(0, 8)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: CompressChip_module_css_default.rowType,
							children: typeChain || "—"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: CompressChip_module_css_default.rowSize,
							children: `${fmt(hit.charsBefore)} → ${fmt(hit.charsAfter)} (-${String(pct)}%)`
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: CompressChip_module_css_default.rowCaret,
							"aria-hidden": true,
							children: open ? "▾" : "▸"
						})
					]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: CompressChip_module_css_default.rowBody,
					children: [
						payload === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: CompressChip_module_css_default.note,
							children: "…"
						}),
						payload !== null && payload !== "loading" && !payload.ok && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: CompressChip_module_css_default.note,
							children: payload.error === "original expired" ? t("chipExpired") : t("chipUnavailable")
						}),
						payload !== null && payload !== "loading" && payload.ok && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: CompressChip_module_css_default.note,
							children: t("chipOriginal", { count: payload.meta?.charsBefore ?? hit.charsBefore })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							className: CompressChip_module_css_default.pre,
							children: payload.originalText
						})] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: CompressChip_module_css_default.meta,
							children: `hash ${hit.hash.slice(0, 12)} · seq ${String(hit.seq)}`
						})
					]
				})]
			});
		}
		/**
		* Render the compression chip for one closed turn.
		* @param props - the elected headroom match and bound copy.
		* @returns the chip element.
		*/
		function CompressChip({ matched, t }) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const rows = matched.hits;
			const before = rows.reduce((s, r) => s + r.charsBefore, 0);
			const after = rows.reduce((s, r) => s + r.charsAfter, 0);
			const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: CompressChip_module_css_default.root,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: CompressChip_module_css_default.head,
					onClick: () => setExpanded((v) => !v),
					"aria-expanded": expanded,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: CompressChip_module_css_default.badge,
							children: "headroom"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("chipCount", {
							count: rows.length,
							before: fmt(before),
							after: fmt(after),
							pct
						}) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: CompressChip_module_css_default.caret,
							"aria-hidden": true,
							children: expanded ? "▾" : "▸"
						})
					]
				}), expanded && rows.map((hit) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChipRow, {
					hit,
					t
				}, hit.hash + String(hit.seq)))]
			});
		}
		//#endregion
		//#region src/client/trajectory-chip.ts
		const API = "/headroom-bridge/api";
		/** Marks rows that already carry a bubble (and powers disposal cleanup). */
		const CHIP_ATTR = "data-hb-chip";
		function el(tag, className, text) {
			const node = document.createElement(tag);
			if (className !== "") node.className = className;
			if (text !== void 0) node.textContent = text;
			return node;
		}
		/** `router:smart_crusher:0.19>router:text:0.67` -> `router:smart_crusher › router:text`. */
		function strategyChain(strategy) {
			if (strategy === "") return "";
			return strategy.split(">").map((step) => step.split(":").slice(0, 2).join(":")).join(" › ");
		}
		function bubble(hits, t) {
			const box = el("div", CompressChip_module_css_default.root);
			box.setAttribute(CHIP_ATTR, "1");
			let open = false;
			let body;
			const before = hits.reduce((sum, h) => sum + h.charsBefore, 0);
			const after = hits.reduce((sum, h) => sum + h.charsAfter, 0);
			const pct = before > 0 ? Math.round(100 * (1 - after / before)) : 0;
			const head = el("div", CompressChip_module_css_default.head);
			head.appendChild(el("span", CompressChip_module_css_default.badge, "headroom"));
			head.appendChild(el("span", "", t("chipCount", {
				count: hits.length,
				before,
				after,
				pct
			})));
			const caret = el("span", CompressChip_module_css_default.caret, "▸");
			head.appendChild(caret);
			box.appendChild(head);
			head.addEventListener("click", (event) => {
				event.stopPropagation();
				open = !open;
				caret.textContent = open ? "▾" : "▸";
				if (!open) {
					body?.remove();
					body = void 0;
					return;
				}
				body = el("div", "");
				for (const hit of hits) body.appendChild(row(hit, t));
				box.appendChild(body);
			});
			return box;
		}
		function row(hit, t) {
			const rowBox = el("div", CompressChip_module_css_default.row);
			const head = el("div", CompressChip_module_css_default.rowHead);
			head.appendChild(el("span", CompressChip_module_css_default.rowTool, hit.toolName === "" ? hit.hash.slice(0, 8) : hit.toolName));
			const chain = strategyChain(hit.strategy);
			if (chain !== "") head.appendChild(el("span", CompressChip_module_css_default.rowType, chain));
			head.appendChild(el("span", CompressChip_module_css_default.rowSize, `${hit.charsBefore} → ${hit.charsAfter}`));
			head.appendChild(el("span", CompressChip_module_css_default.rowCaret, "▸"));
			rowBox.appendChild(head);
			let open = false;
			let loaded = false;
			let detail;
			head.addEventListener("click", (event) => {
				event.stopPropagation();
				open = !open;
				if (!open) {
					detail?.remove();
					detail = void 0;
					return;
				}
				detail = el("div", CompressChip_module_css_default.rowBody);
				const note = el("p", CompressChip_module_css_default.note, t("ledgerShowOriginal"));
				detail.appendChild(note);
				rowBox.appendChild(detail);
				if (loaded || !hit.originalAvailable) {
					if (!hit.originalAvailable) note.textContent = t("chipExpired");
					loaded = true;
					return;
				}
				loaded = true;
				fetch(`${API}/ledger/entry?hash=${encodeURIComponent(hit.hash)}`).then((res) => res.json().then((d) => ({
					res,
					d
				}))).then(({ res, d }) => {
					if (detail === void 0) return;
					note.remove();
					if (!res.ok) {
						detail.appendChild(el("p", CompressChip_module_css_default.note, t("chipUnavailable")));
						return;
					}
					const text = d.originalText ?? d.meta?.originalText ?? "";
					const pre = el("pre", CompressChip_module_css_default.pre, text);
					detail.appendChild(pre);
					detail.appendChild(el("p", CompressChip_module_css_default.meta, `hash=${hit.hash}`));
				}).catch(() => {
					if (detail === void 0) return;
					note.textContent = t("chipUnavailable");
				});
			});
			return rowBox;
		}
		/**
		* Install the trajectory observer for one fiber.
		* @param ctx - plugin context (uses the injected `sessions` feed).
		* @param t - translator bound to this plugin's namespace.
		* @returns a disposer, or `undefined` outside a browser.
		*/
		function installTrajectoryChip(ctx, t) {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined" || document.body === null) return;
			let current;
			let rows = /* @__PURE__ */ new Map();
			let disposed = false;
			let scanQueued = false;
			const scan = () => {
				scanQueued = false;
				if (disposed || current === void 0 || rows.size === 0) return;
				const table = document.querySelector("[data-trajectory-scroll]");
				if (table === null) return;
				for (const tr of table.querySelectorAll("tr[data-trajectory-row-key]")) {
					if (tr.getAttribute(CHIP_ATTR) !== null) continue;
					const raw = tr.getAttribute("data-trajectory-row-key") ?? "";
					let key;
					try {
						key = decodeURIComponent(raw);
					} catch {
						continue;
					}
					const parts = key.split("\0");
					if (parts[1] !== "call") continue;
					const hits = rows.get(parts[2]);
					if (hits === void 0 || hits.length === 0) continue;
					tr.setAttribute(CHIP_ATTR, "1");
					const cell = tr.querySelector("td:last-of-type");
					if (cell === null) continue;
					cell.appendChild(bubble(hits, t));
				}
			};
			const scheduleScan = () => {
				if (scanQueued) return;
				scanQueued = true;
				requestAnimationFrame(scan);
			};
			const load = (sessionId) => {
				fetch(`${API}/ledger/activity?limit=200&session=${encodeURIComponent(sessionId)}`).then((res) => res.json()).then((data) => {
					if (disposed || current !== sessionId) return;
					const next = /* @__PURE__ */ new Map();
					for (const r of data.rows ?? []) {
						if (r.kind !== "ledger" || r.callId === "" || r.hash === "") continue;
						const list = next.get(r.callId) ?? [];
						list.push({
							hash: r.hash,
							toolName: r.toolName,
							charsBefore: r.charsBefore,
							charsAfter: r.charsAfter,
							strategy: r.strategy,
							originalAvailable: r.originalAvailable
						});
						next.set(r.callId, list);
					}
					rows = next;
					scheduleScan();
				}).catch(() => {});
			};
			const watch = () => {
				const next = ctx.sessions.list.getSnapshot().current;
				if (next === current) return;
				current = next;
				rows = /* @__PURE__ */ new Map();
				if (current !== void 0) load(current);
			};
			const offList = ctx.sessions.list.subscribe(watch);
			watch();
			const observer = new MutationObserver(scheduleScan);
			observer.observe(document.body, {
				childList: true,
				subtree: true
			});
			return () => {
				disposed = true;
				offList();
				observer.disconnect();
				for (const node of document.querySelectorAll(`[${CHIP_ATTR}]`)) node.remove();
			};
		}
		/** Known labels of the trajectory view tab (ui-trajectory's `view.trajectory`, zh/en). */
		const TRAJECTORY_TAB_LABELS = ["轨迹", "Trajectory"];
		/**
		* Drive the mounted conversation view onto the trajectory, best-effort
		* focused on one tool call. Complements the cold-mount path (localStorage
		* pre-write, which the official store hydrates on first mount): a session
		* already mounted in this browser run keeps its cached store and ignores the
		* preference, so the warm path is direct DOM - click the view tab
		* (role=tab/aria-selected, label-matched with a two-tab fallback) and scroll
		* the `kind\0call\0<callId>` row into view with a brief green flash. Rows
		* folded out of the rendered window may never mount; then the view switch
		* stands and the bubbles cover manual scrolling.
		* @param callId - tool call to focus, when the source row knows one.
		* @returns nothing.
		*/
		function driveTrajectoryView(callId) {
			if (typeof document === "undefined" || typeof setTimeout === "undefined") return;
			const clickTab = () => {
				const tabs = Array.from(document.querySelectorAll("[role=\"tab\"]"));
				if (tabs.length === 0) return;
				const unselected = tabs.filter((tab) => tab.getAttribute("aria-selected") !== "true");
				if (unselected.length === 0) return;
				(unselected.find((tab) => TRAJECTORY_TAB_LABELS.includes((tab.textContent ?? "").trim())) ?? (tabs.length === 2 ? unselected[0] : void 0))?.click();
			};
			const focusRow = () => {
				if (callId === void 0 || callId === "") return true;
				const table = document.querySelector("[data-trajectory-scroll]");
				if (table === null) return false;
				const key = encodeURIComponent(`tool\u0000call\u0000${callId}`);
				const row = table.querySelector(`tr[data-trajectory-row-key="${key}"]`);
				if (row === null) return false;
				row.scrollIntoView({
					block: "center",
					behavior: "smooth"
				});
				const tr = row;
				tr.style.outline = "1px solid rgba(34, 197, 94, .65)";
				tr.style.outlineOffset = "-1px";
				setTimeout(() => {
					tr.style.outline = "";
					tr.style.outlineOffset = "";
				}, 1800);
				return true;
			};
			let tries = 0;
			const step = () => {
				tries++;
				clickTab();
				if (focusRow()) return;
				if (tries < 25) setTimeout(step, 120);
			};
			step();
		}
		//#endregion
		//#region src/turn-projection.ts
		/** The bridge's own retrieval-marker shape (src/marker.ts on the host side). */
		const MARKER_RE = /\[headroom-bridge: (\d+)->(\d+) chars offloaded\. Retrieve the exact original with headroom_retrieve hash=([0-9a-f]{12,24})\]/g;
		function scanText(text) {
			const found = [];
			for (const match of text.matchAll(MARKER_RE)) found.push({
				before: Number(match[1]),
				after: Number(match[2]),
				hash: String(match[3])
			});
			return found;
		}
		/** Join every text block of a tool-result message. */
		function resultText(content) {
			const parts = [];
			for (const block of content) {
				const b = block;
				if (!Array.isArray(b?.content)) continue;
				for (const inner of b.content) if (inner?.type === "text" && typeof inner.text === "string") parts.push(inner.text);
			}
			return parts.join("\n");
		}
		/** Turn-local compression accumulator; it publishes no view Node. */
		const headroomTurnDefinition = {
			kind: "headroom",
			match: (event) => {
				if (event.type === "turn/start") return {
					id: String(event.data.turn),
					role: "start"
				};
				if (event.type === "tool/call") return {
					id: String(event.data.turn),
					role: "update"
				};
				if (event.type === "tool/result") return {
					id: String(event.data.turn),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "turn/start") throw new Error("headroom start requires turn/start");
				return {
					turn: match.event.data.turn,
					hits: [],
					names: /* @__PURE__ */ new Map()
				};
			},
			update: (context, match) => {
				if (match.event.type === "tool/call") {
					const callId = String(match.event.data.callId);
					const name = typeof match.event.data.name === "string" ? match.event.data.name : "";
					if (name.length === 0 || context.state.names.get(callId) === name) return context.state;
					return {
						...context.state,
						names: new Map(context.state.names).set(callId, name)
					};
				}
				if (match.event.type !== "tool/result") return context.state;
				const message = match.event.data.message;
				if (!Array.isArray(message?.content)) return context.state;
				const callId = String(message.source?.callId ?? "");
				const hits = [];
				for (const found of scanText(resultText(message.content))) hits.push({
					hash: found.hash,
					charsBefore: found.before,
					charsAfter: found.after,
					callId,
					toolName: context.state.names.get(callId) ?? "",
					seq: Number(match.event.seq)
				});
				if (hits.length === 0) return context.state;
				return {
					...context.state,
					hits: [...context.state.hits, ...hits]
				};
			}
		};
		/**
		* Claim the turn-tail chain only when the closing turn carries compressions.
		* @param owner - Turn-tail owner currency for the closing assistant.
		* @returns the turn's hits as the component's match, or null to decline.
		*/
		function selectHeadroom(owner) {
			const data = owner.turn.data.get("headroom");
			return data === void 0 || data.hits.length === 0 ? null : data;
		}
		//#endregion
		//#region src/client/locales.ts
		/** English copy. */
		const en = {
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			expand: "Show settings",
			collapse: "Hide settings",
			save: "Save",
			saving: "Saving…",
			discard: "Discard",
			unsaved: "Unsaved",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			invalidNumber: "Enter a number, or leave blank to use the default.",
			invalidValue: "Pick one of the offered values, or leave blank to use the default.",
			headroomTitle: "Headroom compression",
			headroomDescription: "Content-aware compression of model-visible content.",
			mode: "Mode",
			modeHint: "Audit records savings only; live replaces accepted results.",
			enabled: "Compression enabled",
			enabledHint: "Master switch for both compression arms.",
			baseUrl: "Proxy endpoint",
			baseUrlHint: "Leave blank to use the default proxy.",
			timeoutMs: "Request timeout (ms)",
			timeoutMsHint: "How long one compression request may run before it is abandoned.",
			minChars: "Minimum length (chars)",
			minCharsHint: "Compress only text at least this long.",
			minSavingsRatio: "Minimum savings ratio",
			minSavingsRatioHint: "Replace only when the response saves at least this fraction.",
			protectErrorOutputs: "Protect error outputs",
			protectErrorOutputsHint: "Failed results stay verbatim.",
			statusTitle: "Status",
			statsMode: "Running mode",
			statsEnabled: "Enabled",
			statsProxy: "Proxy",
			statsAttemptsFailures: "Attempts / failures",
			statsAdopted: "Adopted",
			statsSavedChars: "Chars saved",
			statsLedgerEntries: "Ledger entries",
			statsHealth: "Proxy health",
			healthUnknown: "n/a",
			statsUnreachable: "Status API unreachable.",
			statsLoading: "Loading…",
			statsFailed: "Status unavailable: {message}",
			ledgerTitle: "Recent compressions",
			ledgerEmpty: "No records yet.",
			chipCount: "Compressed {count} results this turn · {before} → {after} chars (-{pct}%)",
			chipOriginal: "Original ({count} chars) — the compressed form is the tool row above:",
			chipExpired: "Original demoted after leaving the context window (metadata retained).",
			chipUnavailable: "Original unavailable.",
			ledgerActivity: "Recent operations",
			ledgerShowOriginal: "Show original",
			ledgerOriginalGone: "Original expired"
		};
		/** Simplified Chinese copy. */
		const zh = {
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			expand: "展开设置",
			collapse: "收起设置",
			save: "保存",
			saving: "保存中…",
			discard: "放弃修改",
			unsaved: "未保存",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			invalidNumber: "请填数字；留空表示使用默认值。",
			invalidValue: "请选择给出的值；留空表示使用默认值。",
			headroomTitle: "Headroom 压缩",
			headroomDescription: "对模型可见内容做内容感知压缩。",
			mode: "模式",
			modeHint: "审计只记录节省；实况会替换被采纳的结果。",
			enabled: "启用压缩",
			enabledHint: "双臂总开关。",
			baseUrl: "Proxy 地址",
			baseUrlHint: "留空则使用默认 Proxy 地址。",
			timeoutMs: "请求超时（毫秒）",
			timeoutMsHint: "单次压缩请求允许运行多久，超时即放弃。",
			minChars: "最小字符数",
			minCharsHint: "仅压缩达到该长度的文本。",
			minSavingsRatio: "最低节省比例",
			minSavingsRatioHint: "节省达到该比例才替换。",
			protectErrorOutputs: "保护错误输出",
			protectErrorOutputsHint: "失败结果保持原样。",
			statusTitle: "状态",
			statsMode: "运行模式",
			statsEnabled: "开关",
			statsProxy: "Proxy",
			statsAttemptsFailures: "尝试/失败",
			statsAdopted: "已采纳",
			statsSavedChars: "节省字符",
			statsLedgerEntries: "台账条目",
			statsHealth: "Proxy 健康",
			healthUnknown: "n/a",
			statsUnreachable: "状态 API 不可达。",
			statsLoading: "加载中…",
			statsFailed: "状态不可用：{message}",
			ledgerTitle: "最近压缩",
			ledgerEmpty: "（暂无记录）",
			chipCount: "本轮压缩 {count} 处 · {before} → {after} 字符 (-{pct}%)",
			chipOriginal: "原始内容（{count} 字符）— 压缩后的形态即上方工具行所示：",
			chipExpired: "原文已出窗降级（台账仅保留元数据）。",
			chipUnavailable: "原文不可用。",
			ledgerActivity: "近期操作",
			ledgerShowOriginal: "查看原文",
			ledgerOriginalGone: "原文已过期"
		};
		//#endregion
		//#region src/client/index.ts
		/** Dictionary namespace owned by this package's card. */
		const NS = "settings.plugins.headroom";
		/**
		* ui-conversation persists the per-session conversation store (whole value)
		* under this localStorage key, and session open restores the view from it
		* (activateView reads readConversationViewPreference). Pre-writing
		* view=trajectory + viewRequest{focus:callId} therefore lands the deep link
		* on the trajectory's official inspect-focus path (TrajectoryView consumes
		* viewRequest.focus as its anchor, expanding history to reach it).
		*/
		const CONVERSATION_STORE_KEY = "dsh.conversation";
		/** Required services: slots, locale, the settings scope, the conversation projection, and the session feed. */
		const inject = [
			"slots",
			"locale",
			"settingsScope",
			"uiConversation",
			"sessions"
		];
		/**
		* Ask the next open of one session to land on its trajectory view, focused
		* on a tool call when given. Pure preference pre-write (no DOM tricks); a
		* session whose view is already mounted keeps its live state - the
		* trajectory bubbles cover in-session navigation anyway.
		* @param sessionId - session to open.
		* @param callId - tool call to focus, when the source row knows one.
		* @returns nothing; storage failures silently degrade to open-only.
		*/
		function preferTrajectoryView(sessionId, callId) {
			try {
				const key = `${CONVERSATION_STORE_KEY}.${sessionId}`;
				const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
				saved.view = "trajectory";
				saved.viewRequest = callId === void 0 || callId === "" ? null : {
					view: "trajectory",
					focus: callId
				};
				localStorage.setItem(key, JSON.stringify(saved));
			} catch {}
		}
		/**
		* Mount the headroom settings card and the trajectory compression chip.
		* @param ctx - client context with the slots, locale, settingsScope and uiConversation services.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "@deepseek-ai/dsh-headroom-bridge: card dictionaries");
			const nav = ctx.get("uiWorkspace");
			const headroom = new HeadroomCardController(ctx.settingsScope.bind({ namespace: HEADROOM_NS }), nav?.openSession ? (id, callId) => {
				preferTrajectoryView(id, callId);
				nav.openSession?.(id);
				driveTrajectoryView(callId);
			} : void 0);
			ctx.effect(() => ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: HEADROOM_NS,
				locale: NS,
				inject: () => headroom.inject()
			}, HeadroomCard)), "@deepseek-ai/dsh-headroom-bridge: settings card");
			ctx.effect(() => ctx.uiConversation.events.register(headroomTurnDefinition), "@deepseek-ai/dsh-headroom-bridge: turn projection");
			ctx.effect(() => ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				priority: 100,
				select: selectHeadroom,
				locale: NS
			}, CompressChip)), "@deepseek-ai/dsh-headroom-bridge: trajectory chip");
			const translate = ctx.locale.bind(NS);
			ctx.effect(() => installTrajectoryChip(ctx, (key, vars) => translate(key, vars)), "@deepseek-ai/dsh-headroom-bridge: trajectory bubbles");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map