window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-headroom-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
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
				const store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(project());
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
			form;
			store;
			/** @param scope - the bound settings scope for the 'headroom' namespace. */
			constructor(scope) {
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
					...this.form.actions()
				};
			}
		};
		//#endregion
		//#region \0dsh-css:/media/ict/19BD52556106DE5A/dsh-headroom-bridge/src/client/fields.module.css.mjs
		const css$2 = ".cJn9_W_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.cJn9_W_field+.cJn9_W_field{border-top:1px solid var(--dsw-alias-border-l2)}.cJn9_W_head{align-items:center;gap:8px;display:flex}.cJn9_W_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.cJn9_W_badges{align-items:center;gap:8px;display:inline-flex}.cJn9_W_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.cJn9_W_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}.cJn9_W_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.cJn9_W_reset:disabled{cursor:default}.cJn9_W_input,.cJn9_W_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}.cJn9_W_input:focus-visible,.cJn9_W_select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.cJn9_W_input:disabled,.cJn9_W_select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.cJn9_W_inputInvalid{border-color:var(--dsw-alias-label-error);}.cJn9_W_selectInvalid{border-color:var(--dsw-alias-label-error);}.cJn9_W_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.cJn9_W_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.cJn9_W_switch{box-sizing:border-box;background:var(--dsw-alias-border-l3);cursor:pointer;border:0;border-radius:10px;flex:none;width:36px;height:20px;padding:2px;position:relative}.cJn9_W_switchOn{background:var(--dsw-alias-brand-primary)}.cJn9_W_switch:disabled{cursor:default;opacity:.5}.cJn9_W_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.cJn9_W_thumb{background:var(--dsw-alias-label-primary-foreground);border-radius:50%;width:16px;height:16px;transition:transform .12s;display:block}.cJn9_W_switchOn .cJn9_W_thumb{transform:translate(16px)}";
		const tagId$2 = "@dsh-external/dsh-headroom-bridge/fields.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-headroom-bridge";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
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
		const css$1 = "._3DyMTq_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}._3DyMTq_card:hover{border-color:var(--dsw-alias-label-dimmed)}._3DyMTq_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}._3DyMTq_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}._3DyMTq_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}._3DyMTq_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}._3DyMTq_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}._3DyMTq_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}._3DyMTq_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}._3DyMTq_chevronOpen{transform:rotate(180deg)}._3DyMTq_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}._3DyMTq_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}._3DyMTq_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}._3DyMTq_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}._3DyMTq_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}._3DyMTq_discard,._3DyMTq_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}._3DyMTq_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}._3DyMTq_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}._3DyMTq_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}._3DyMTq_discard:disabled,._3DyMTq_save:disabled{opacity:.4;cursor:default}._3DyMTq_discard:focus-visible,._3DyMTq_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}";
		const tagId$1 = "@dsh-external/dsh-headroom-bridge/PluginCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-headroom-bridge";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
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
		const css = ".xfW8HW_ledger{border-top:1px solid var(--dsw-alias-border-l2)}.xfW8HW_block{gap:8px;padding:12px 0;display:grid}.xfW8HW_blockTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;font-weight:600;line-height:1.5}.xfW8HW_statRow{justify-content:space-between;align-items:baseline;gap:16px;font-size:12px;line-height:1.5;display:flex}.xfW8HW_statLabel{color:var(--dsw-alias-label-secondary);flex:none}.xfW8HW_statValue{text-overflow:ellipsis;white-space:nowrap;text-align:right;min-width:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow:hidden}.xfW8HW_statNote{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.xfW8HW_statError{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.xfW8HW_ledgerRow{color:var(--dsw-alias-label-secondary);justify-content:space-between;align-items:baseline;gap:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;display:flex}.xfW8HW_ledgerHash{color:var(--dsw-alias-label-tertiary);flex:none}";
		const tagId = "@dsh-external/dsh-headroom-bridge/HeadroomCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-headroom-bridge";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var HeadroomCard_module_css_default = {
			"block": "xfW8HW_block",
			"blockTitle": "xfW8HW_blockTitle",
			"ledger": "xfW8HW_ledger",
			"ledgerHash": "xfW8HW_ledgerHash",
			"ledgerRow": "xfW8HW_ledgerRow",
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
		/** Recent compression ledger block. */
		function LedgerSection({ t }) {
			const [rows, setRows] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let alive = true;
				fetch("/headroom-bridge/api/ledger/recent?limit=8").then((res) => res.json()).then((d) => {
					if (alive && d.ok && Array.isArray(d.entries)) setRows(d.entries);
				}).catch(() => {});
				return () => {
					alive = false;
				};
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: `${HeadroomCard_module_css_default.block} ${HeadroomCard_module_css_default.ledger}`,
				"aria-label": t("ledgerTitle"),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					className: HeadroomCard_module_css_default.blockTitle,
					children: t("ledgerTitle")
				}), rows === null ? null : rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: HeadroomCard_module_css_default.statNote,
					children: t("ledgerEmpty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: rows.map((entry) => {
					const saved = entry.charsBefore - entry.charsAfter;
					const pct = entry.charsBefore > 0 ? Math.round(saved / entry.charsBefore * 100) : 0;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: HeadroomCard_module_css_default.ledgerRow,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: HeadroomCard_module_css_default.ledgerHash,
								children: entry.hash.slice(0, 10)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: entry.toolName }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: `${String(entry.charsBefore)}->${String(entry.charsAfter)} (-${String(pct)}%)` })
						]
					}, entry.hash);
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LedgerSection, { t })
				]
			});
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
			ledgerEmpty: "No records yet."
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
			ledgerEmpty: "（暂无记录）"
		};
		//#endregion
		//#region src/client/index.ts
		/** Dictionary namespace owned by this package's card. */
		const NS = "settings.plugins.headroom";
		/** Required services: the slot registry, the locale plugin, and the settings scope. */
		const inject = [
			"slots",
			"locale",
			"settingsScope"
		];
		/**
		* Mount the headroom settings card.
		* @param ctx - client context with the slots, locale, and settingsScope services.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "@deepseek-ai/dsh-headroom-bridge: card dictionaries");
			const headroom = new HeadroomCardController(ctx.settingsScope.bind({ namespace: HEADROOM_NS }));
			ctx.effect(() => ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: HEADROOM_NS,
				locale: NS,
				inject: () => headroom.inject()
			}, HeadroomCard)), "@deepseek-ai/dsh-headroom-bridge: settings card");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map