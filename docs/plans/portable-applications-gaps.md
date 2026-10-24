# Portable application gap evidence

Date: 2026-10-23. Scope: PP5 of the accepted portable application roadmap.

The evidence below records the original baseline, `9498cb3`. The user subsequently approved all three proposed extensions.
The [extension plan](2026-10-23-portable-extensions.md) and [worklog](portable-extensions-worklog.md) track their implementation and current checks.
The review-only descriptions below preserve the original design decisions. They no longer request approval.

## Result

The probes found two language gaps and one tooling gap. Named platform selection uses existing composition.

No candidate blocks the portable publisher. The application uses current services, Layers, nominal types, effects, and typed host adapters.

The acceptance rule therefore selects no compiler extension. The sealed-type and pure-type designs remain review-only proposals.

The dependency-policy design also remains review-only. It changes project tooling, not the language.

## Evidence method

The tests use `checkProject(memoryHost(...))` through the public core API. Every accepted probe also uses `lowerProject` and `validateProject`.

The accepted probes contain no checker internals. The rejected probes assert the public diagnostic codes.

The focused command was:

```text
deno test tests/portable_architecture_test.ts
```

The final commands and results are recorded in the companion worklog. Each probe runs without a subprocess.

The evidence is in `tests/portable_architecture_test.ts`. The test does not emit or execute generated TypeScript.

## Named platform selection

Disposition: existing composition.

Two modules import one `Clock` service. Each module exports a different `Layer<Clock>` implementation.

The entry module imports both Layers. Each `provide` call discharges the same `Clock.now` identity.

Checking, lowering, and independent validation accept both selections. A new `platform` declaration would duplicate this composition.

Host selection has a narrower limit. One `effektive.json` host name maps one interface to one host module for that build.

The language does not compare entry signatures across separate project configurations. No accepted invariant requires that comparison.

The portable publisher can select its memory or SQLite adapter at its application boundary. This limit does not block that application.

## Sealed source types

Disposition: language gap, with no demonstrated application blocker.

A non-exported nominal declaration cannot be imported. The checker reports `unknown-name/002`.

An exported alias can name a private nominal type. Calling that alias as a constructor gives `type-mismatch/010`.

That composition hides construction already. A cross-module record update through the exported alias still retains the private nominal type.

An exported nominal record can be updated in another module. The update keeps the nominal type.

An exported nominal primitive permits two same-type operands in subtraction. The result keeps the nominal type.

The accepted probe assigns `one - two` to `Positive`. The value is negative, so a positive-value convention is not sealed.

The same probe widens `Positive` to its base `int`. It also derives `Schema<Positive>` outside the declaring module.

`schemaDecode` then produces `Positive` from `unknown`. Checking, lowering, and independent validation accept all three paths.

These facts show a language gap for a module-owned invariant. They do not show a publisher failure.

### Review-only sealed-type design

The minimal syntax adds one modifier:

```eff
export sealed nominal Positive = int
export sealed nominal Article = { id: ArticleId, revision: Revision }
```

An open `nominal` keeps every current rule. A `sealed nominal` exports its type and fields, but not its construction authority.

Only the declaring `.eff` module can call the constructor. The first version rejects `sealed nominal` in `.effi` files.

Only the declaring module can keep a sealed nominal type after a record update. An outside update receives `sealed/002`.

Only the declaring module can perform arithmetic that returns the sealed nominal type. Outside comparisons remain legal.

Outside the owner, a sealed value does not fit its base type. The owner can export an explicit conversion function.

Outside arithmetic can return a base type only through such a function. This rule prevents implicit base widening.

Only the declaring module can derive a `Schema` whose decoded type contains the sealed type. This restriction covers nested positions.

The restriction also covers `schemaDecode`, `schemaMake`, and schema constructors. The module can export an explicit decoder when required.

Field reads remain legal for sealed nominal records. A module can export an explicit base conversion when disclosure is intentional.

The design adds no predicates and no refinement solver. The declaring module owns validation before it calls the constructor.

Existing source stays compatible because existing nominal declarations remain open. The new modifier changes only new declarations.

The module interface records the sealed flag. The flag participates in the interface hash and imported type facts.

Typed IR adds `sealed?: true` to a nominal definition. Existing nominal construction and update nodes remain unchanged.

The checker compares each authority-sensitive expression with the nominal type's module identifier. A mismatch reports a sealed-type diagnostic.

The independent validator repeats that module check. It rejects a forged constructor, retained update, widening, or schema derivation.

Emission keeps the current runtime schema and nominal representation. The restriction is static and adds no runtime branch.

The editor highlights `sealed` as a declaration modifier. Completion offers it before `nominal`, and hover reports the sealed status.

A positive acceptance case constructs and decodes inside the owner. Another module can pass, compare, and read the resulting value.

A negative case calls the constructor outside the owner. Other negative cases cover update, arithmetic, widening, and schema derivation.

A mutation case changes the nominal identifier in each restricted IR node. Independent validation must reject each changed module.

The user must review this design before implementation. The current application evidence does not select it.

## Explicit purity contracts

Disposition: language gap, with no demonstrated application blocker.

`run(defer(() => 1))` has effect execution. Its failure and requirement rows are both empty.

The lowered function records `execution: "effect"`, `failures: []`, and `requirements: []`. Empty rows do not imply pure execution.

An imported function keeps its inferred effect mode. Calling that function in a module initializer reports `execution-mode/002`.

A function-type parameter uses effect execution by default. Passing that parameter to `map` reports `execution-mode/001`.

The source cannot declare that higher-order parameter as pure. Inline callbacks and inferred module functions remain the available pure forms.

A fully provided service call also retains effect execution after its requirement disappears. The corresponding probe validates that distinction independently.

The portable publisher uses those existing forms. The missing contract does not block the application.

The accepted `TextRules` primitive is trusted host classification. It does not establish that source text processing is pure.

### Review-only pure-type design

The minimal syntax adds `pure` to a function type:

```eff
export const apply = (
  values: Int[],
  callback: pure (value: Int) => Int
): Int[] => map(values, callback)
```

`pure` means pure execution with empty failure and requirement rows. All three conditions form one contract.

The checker rejects any declared failures or requirements on a pure function type. It also rejects an effectful supplied function.

An inferred pure module function fits a pure function type. A pure inline arrow also fits when its body stays pure.

A pure function value fits an existing effect function type. That conversion loses purity information but preserves safety.

An effect function value never fits a pure function type. Existing unmarked function types keep their current effect default.

`run`, `provide`, and `defer` execution keep their current inference rules. Empty rows do not change their execution mode.

Provider acquisition also keeps a separate execution mode and effect rows. A provider with empty rows is not automatically pure.

The syntax changes the type parser and formatter. It does not add a new expression or declaration form.

The IR already stores `FunctionType.execution` and both effect rows. The interface and IR shapes need no new field.

Independent validation checks that every pure function type has empty rows. It checks each call against the recorded execution mode.

Emission uses the current TypeScript function type. TypeScript does not encode the Effektive execution mode.

The editor highlights and completes `pure` in function-type positions. Hover includes `pure` in the displayed function type.

A positive case passes an inferred pure imported function to `apply`. Another positive case supplies a pure inline arrow.

A negative case passes a function that calls a service. Another negative case adds a failure row to a pure function type.

A provider case confirms that empty provider rows do not satisfy a pure callback. A `provide` expression remains effectful.

A mutation case changes an IR function type from effect to pure without clearing its rows. Independent validation must reject it.

Mutation cases also relabel empty-row `run` and `provide` computations as pure. Independent validation must reject both.

The user must review this design before implementation. The current application evidence does not select it.

## Architectural import rules

Disposition: tooling gap, with no demonstrated application blocker.

The loader accepts an acyclic `domain.eff` import from `host:clock`. Checking, lowering, and independent validation all accept it.

Removing the host registration produces `module/002`. Registration checks availability, not architectural direction.

A host interface that imports the domain while the domain imports that host produces `module/003`. That diagnostic reports a cycle.

Cycle detection and dependency direction are different policies. The current loader enforces only cycles and registered host names.

The portable publisher follows its intended direction without enforcement. The missing policy does not block the application.

### Review-only dependency policy

The minimal design adds an optional `imports` list to `effektive.json`:

```json
{
  "imports": [
    { "from": "domain/**", "allow": ["domain/**"] },
    { "from": "feature/**", "allow": ["domain/**", "feature/**"] },
    { "from": "adapter/**", "allow": ["domain/**", "feature/**", "platform/**", "host:*"] }
  ]
}
```

The policy applies only when `imports` exists. Old projects keep their current behavior.

The first matching `from` rule controls each source module. Its `allow` patterns match normalized, root-relative module paths. Host targets match their `host:` specifier.

No matching rule leaves the module unrestricted. This choice permits gradual adoption in an existing project.

A forbidden direct edge reports a project diagnostic on the import specifier. Transitive paths need no separate rule.

Cycle detection still reports `module/003`. A cycle does not become a direction violation, and direction does not imply a cycle.

Named platform selection stays separate. The import policy does not choose a Layer, host module, entry point, or runtime implementation.

The checker applies the policy after module resolution and before declaration checking. Interfaces and typed IR do not change.

Independent validation does not repeat project policy. The validated IR contains resolved modules, not project governance rules.

Emission does not change. The language server republishes the project diagnostic after configuration or import edits.

A positive case permits `feature/**` to import `domain/**`. Another positive case loads a project without the optional policy.

A negative case rejects `domain/**` importing `host:*`. Another negative case rejects an unlisted sibling area.

A mutation case removes one allowed pattern from the configuration. The next project check must report the newly forbidden edge.

The user must review this design before implementation. The current application evidence does not select it.

## PP5 conclusion

Every retained gap has a current counterexample. Every proposal preserves existing source unless the new control is enabled.

No proposal adds a framework, generic facility, or effect runtime. No proposal changes the portable publisher plan.

PP5 supplies evidence and review designs only. It adds no compiler form and makes no extension implementation commitment.

Implementation and validation results are recorded in the separate [extension worklog](portable-extensions-worklog.md).
