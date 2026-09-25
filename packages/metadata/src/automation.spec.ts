import {
  applyFieldRules,
  checkRules,
  compileFormula,
  conditionHolds,
  emptyLayer,
  emptyTenantConfig,
  fillTemplate,
  lockedFields,
  mergeLayers,
  platformBaseLayer,
  validateTenantConfig,
  workflowFor,
  type ConfigLayer,
  type EntityDef,
  type RuleDef,
  type WorkflowDef,
} from './index';

const entity: EntityDef = {
  key: 'purchase',
  kind: 'custom',
  label: { en: 'Purchase request' },
  pluralLabel: { en: 'Purchase requests' },
  fields: [
    { key: 'title', type: 'text', label: { en: 'Title' } },
    { key: 'amount', type: 'currency', label: { en: 'Amount' } },
    { key: 'discount', type: 'percent', label: { en: 'Discount' } },
    { key: 'reason', type: 'longtext', label: { en: 'Reason' } },
    { key: 'category', type: 'text', label: { en: 'Category' } },
    { key: 'owner', type: 'lookup', target: 'user', label: { en: 'Owner' } },
  ],
};

const workflow: WorkflowDef = {
  entity: 'purchase',
  initialState: 'draft',
  states: [
    { key: 'draft', label: { en: 'Draft' } },
    { key: 'pending', label: { en: 'Pending' }, locked: true, editableFields: ['reason'] },
    { key: 'approved', label: { en: 'Approved' }, locked: true },
    { key: 'rejected', label: { en: 'Rejected' } },
  ],
  actions: [
    {
      key: 'submit',
      label: { en: 'Submit' },
      from: ['draft'],
      to: 'pending',
      requesterOnly: true,
      approval: {
        approvedState: 'approved',
        rejectedState: 'draft',
        levels: [
          {
            key: 'head',
            label: { en: 'Branch head' },
            approvers: [{ type: 'unit_head' }],
            mode: 'any',
          },
          {
            key: 'finance',
            label: { en: 'Finance' },
            condition: 'amount > 50000',
            approvers: [{ type: 'role', roleId: 'a'.repeat(24) }],
            mode: 'all',
            remindAfterHours: 24,
            escalateAfterHours: 48,
          },
        ],
      },
    },
  ],
};

describe('formula context', () => {
  const env = {
    old: { amount: { amount: 100 }, title: 'A' },
    user: { id: 'u1', roles: ['Finance', 'tenant_admin'] },
    unitCodes: ['IN', 'HYD'],
    status: 'draft',
  };
  const fields = { amount: { amount: 250 }, title: 'A' };

  it('reads old values, the user, roles, units and status', () => {
    expect(conditionHolds('amount > old.amount', fields, env)).toBe(true);
    expect(conditionHolds('CHANGED(amount) && !CHANGED(title)', fields, env)).toBe(true);
    expect(conditionHolds('HAS_ROLE("finance") && IN_UNIT("hyd")', fields, env)).toBe(true);
    expect(conditionHolds('user.id = "u1" && STATUS() = "draft"', fields, env)).toBe(true);
    expect(conditionHolds('HAS_ROLE("Sales")', fields, env)).toBe(false);
  });

  it('treats every field as changed on create and rejects unknown context names', () => {
    expect(conditionHolds('CHANGED(title)', fields, {})).toBe(true);
    expect(() => compileFormula('record.amount > 1')).toThrow(/Unknown name/);
    expect(() => compileFormula('CHANGED("amount")')).toThrow(/field name/);
    expect(compileFormula('old.amount + 1').context).toEqual(['old.amount']);
  });

  it('never throws on bad data: the condition just does not hold', () => {
    expect(conditionHolds('title > 5 * "x"', fields, env)).toBe(false);
  });
});

describe('rules', () => {
  const rules: RuleDef[] = [
    {
      key: 'cat',
      entity: 'purchase',
      on: 'save',
      effect: 'set',
      field: 'category',
      value: 'IF(amount > 1000, "big", "small")',
    },
    {
      key: 'why',
      entity: 'purchase',
      on: 'save',
      effect: 'require',
      field: 'reason',
      condition: 'amount > 1000',
    },
    {
      key: 'hide',
      entity: 'purchase',
      on: 'save',
      effect: 'hide',
      field: 'discount',
      condition: '!HAS_ROLE("Manager")',
    },
    { key: 'lock', entity: 'purchase', on: 'update', effect: 'readonly', field: 'owner' },
    {
      key: 'cap',
      entity: 'purchase',
      on: 'save',
      effect: 'block',
      condition: 'discount > 20',
      message: {
        en: 'Discount above 20% needs a manager',
        hi: '20% से अधिक छूट के लिए प्रबंधक चाहिए',
      },
    },
  ];

  it('sets values, hides and locks fields, and keeps the old value of protected fields', () => {
    const env = { old: { owner: 'u1', discount: 5 }, user: { id: 'u2', roles: [] } };
    const { data, effects } = applyFieldRules(
      entity,
      rules,
      { amount: { amount: 5000 }, owner: 'u9', discount: 50 },
      env,
    );
    expect(data.category).toBe('big');
    expect(data.owner).toBe('u1');
    expect(data.discount).toBe(5);
    expect([...effects.hidden]).toEqual(['discount']);
    expect(checkRules(rules, data, effects, env)).toEqual([
      { field: 'reason', message: 'Required' },
    ]);
  });

  it('blocks with the message in the user language', () => {
    const env = { user: { id: 'u2', roles: ['Manager'] } };
    const { data, effects } = applyFieldRules(
      entity,
      rules,
      { amount: { amount: 10 }, discount: 30 },
      env,
    );
    expect(checkRules(rules, data, effects, env, 'hi')).toEqual([
      { field: '_record', message: '20% से अधिक छूट के लिए प्रबंधक चाहिए' },
    ]);
  });
});

describe('workflow config', () => {
  const layer = (patch: Partial<ConfigLayer>): ConfigLayer => ({
    ...emptyLayer(),
    entities: [entity],
    ...patch,
  });
  const validate = (company: ConfigLayer) =>
    validateTenantConfig({ ...emptyTenantConfig(), company }, { base: [platformBaseLayer()] });

  it('accepts a valid workflow, rules and automations', () => {
    expect(
      validate(
        layer({
          workflows: [workflow],
          automations: [
            {
              key: 'notify_owner',
              entity: 'purchase',
              label: { en: 'Tell the owner' },
              trigger: { type: 'status_changed', to: 'approved' },
              actions: [
                {
                  type: 'notify',
                  template: 'approval.approved',
                  recipients: [{ type: 'field', field: 'owner' }],
                  channels: ['inapp', 'email'],
                },
                { type: 'update', set: [{ field: 'category', value: '"done"' }] },
              ],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('reports broken references', () => {
    const issues = validate(
      layer({
        workflows: [
          {
            ...workflow,
            initialState: 'nope',
            actions: [{ ...workflow.actions[0], to: 'xx', condition: 'missing > 1' }],
          },
        ],
        rules: [
          { key: 'rr', entity: 'purchase', on: 'save', effect: 'set', field: 'ghost', value: '1' },
        ],
        automations: [
          {
            key: 'aa',
            entity: 'purchase',
            label: { en: 'A' },
            trigger: { type: 'schedule', every: 'day' },
            actions: [
              {
                type: 'notify',
                template: 'nope',
                recipients: [{ type: 'field', field: 'title' }],
                channels: ['email'],
              },
            ],
          },
        ],
      }),
    ).map((i) => i.message);
    expect(issues).toEqual(
      expect.arrayContaining([
        'Unknown starting state "nope"',
        'Unknown state "xx"',
        'Unknown field "missing"',
        'Unknown field "ghost"',
        'Choose the time of day',
        'Unknown message template "nope"',
        '"title" must be a field that links to a user',
      ]),
    );
  });

  it('does not allow context in calculated fields', () => {
    const e = {
      ...entity,
      fields: [
        ...entity.fields,
        {
          key: 'calc',
          type: 'formula' as const,
          label: { en: 'C' },
          formula: 'old.amount',
          resultType: 'number' as const,
        },
      ],
    };
    expect(validate(layer({ entities: [e] })).map((i) => i.message)).toContain(
      'old.amount can only be used in rules and workflows',
    );
  });

  it('lets a branch replace the workflow and locks fields by state', () => {
    const branch = { ...workflow, states: workflow.states.map((s) => ({ ...s, locked: false })) };
    const merged = mergeLayers([
      layer({ workflows: [workflow] }),
      { ...emptyLayer(), workflows: [branch] },
    ]);
    expect(workflowFor(merged, 'purchase')).toBe(branch);
    expect([...lockedFields(workflow, 'pending', entity)]).not.toContain('reason');
    expect([...lockedFields(workflow, 'pending', entity)]).toContain('amount');
    expect(lockedFields(workflow, 'draft', entity).size).toBe(0);
  });

  it('reads layers saved before Step 4', () => {
    const old = {
      entities: [],
      picklists: [],
      forms: [],
      listViews: [],
      numbering: [],
    } as unknown as ConfigLayer;
    expect(mergeLayers([old]).workflows).toEqual([]);
  });
});

describe('templates', () => {
  it('fills placeholders and drops unknown ones', () => {
    expect(
      fillTemplate('{{actor.name}} asks about {{record.title}} ({{record.amount}}) {{nope}}', {
        actor: { name: 'Asha' },
        record: { title: 'Laptops', amount: { amount: 5000 } },
      }),
    ).toBe('Asha asks about Laptops (5000)');
  });
});
