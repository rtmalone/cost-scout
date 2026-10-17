/**
 * The synthetic cloud environment: what resources exist, what they cost, how
 * they behave day to day, and which ones are deliberately wasteful.
 *
 * Ground truth for the evals is derived from the `waste` and `decoy`
 * annotations on these specs, so the dataset and the answer key cannot drift
 * apart. Change a resource here and both regenerate together.
 *
 * Prices are rounded on-demand list prices; close enough to be realistic,
 * not meant to be a pricing reference.
 */

import type { FindingCategory } from '../findings.ts';

export const PERIOD_START = '2026-07-03';
export const PERIOD_DAYS = 90;
/** The day the analysis is "run". Used to judge resource age. */
export const ANALYSIS_DATE = '2026-10-01';
export const DAYS_PER_MONTH = 30;

export type Rng = () => number;

export interface DayContext {
  /** 0-based index into the billing period. */
  day: number;
  date: string;
  weekday: boolean;
  rng: Rng;
}

/** [metric_name, value, unit] */
export type Metric = [string, number, string];

export interface DaySample {
  /** Billable usage in `usageUnit`. 0 means no charge row for the day. */
  usage: number;
  metrics?: Metric[];
}

export interface Account {
  billingAccountId: string;
  id: string;
  name: string;
}

export interface WasteTag {
  /** Resources that share an id form one ground-truth finding. */
  id: string;
  category: FindingCategory;
  title: string;
  /** This resource's share of the finding's monthly savings. */
  monthlySavingsUsd: number;
  /** How far off the agent's savings estimate can be and still count as correct. */
  tolerancePct: number;
}

export interface ResourceSpec {
  id: string;
  name: string;
  provider: 'AWS' | 'Microsoft';
  account: Account;
  region: string;
  serviceName: string;
  serviceCategory: string;
  resourceType: string;
  skuId: string;
  chargeDescription: string;
  createdAt: string;
  attributes: Record<string, unknown>;
  tags: Record<string, string>;
  unitPrice: number;
  usageUnit: string;
  sample: (ctx: DayContext) => DaySample;
  /** A planted problem the agent should find. */
  waste?: WasteTag;
  /** Looks suspicious but is fine. The agent should NOT flag it. */
  decoy?: string;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const AWS_PROD: Account = { billingAccountId: '900000000001', id: '111111111111', name: 'acme-prod' };
const AWS_DEV: Account = { billingAccountId: '900000000001', id: '222222222222', name: 'acme-dev' };
const AZ_ANALYTICS: Account = { billingAccountId: 'ba-acme-ea', id: 'sub-3f9c2a71', name: 'acme-analytics' };

const AZ_RG = `/subscriptions/${AZ_ANALYTICS.id}/resourceGroups/rg-analytics/providers`;

// ---------------------------------------------------------------------------
// Behaviour helpers
// ---------------------------------------------------------------------------

const around = (rng: Rng, center: number, spread: number) => center + (rng() * 2 - 1) * spread;
const pct = (n: number) => Math.min(100, Math.max(0, n));

/** On-demand compute that runs 24 hours a day. */
const allDay = 24;

/** Storage billed per GB-month, spread evenly across days. */
const gbMonthsPerDay = (gb: number) => gb / DAYS_PER_MONTH;

function vmMetrics(
  rng: Rng,
  p: { businessCpu: number; offHoursCpu: number; networkMb: number; spread?: number },
): Metric[] {
  const spread = p.spread ?? 0.15;
  const business = pct(around(rng, p.businessCpu, p.businessCpu * spread));
  const offHours = pct(around(rng, p.offHoursCpu, p.offHoursCpu * spread));
  // 9 business hours, 15 off hours.
  const avg = (business * 9 + offHours * 15) / 24;
  return [
    ['cpu_avg_pct', avg, 'Percent'],
    ['cpu_max_pct', pct(Math.max(business, offHours) * 1.4 + 2), 'Percent'],
    ['cpu_business_hours_avg_pct', business, 'Percent'],
    ['cpu_off_hours_avg_pct', offHours, 'Percent'],
    ['network_out_mb', Math.max(0, around(rng, p.networkMb, p.networkMb * spread)), 'Megabytes'],
  ];
}

const busyVm = (cpu: number, networkMb: number) => (ctx: DayContext): DaySample => ({
  usage: allDay,
  metrics: vmMetrics(ctx.rng, { businessCpu: cpu * 1.2, offHoursCpu: cpu * 0.85, networkMb }),
});

const volumeMetrics = (rng: Rng, attached: boolean): Metric[] => [
  ['read_ops', attached ? Math.round(around(rng, 80_000, 20_000)) : 0, 'Count'],
  ['write_ops', attached ? Math.round(around(rng, 40_000, 10_000)) : 0, 'Count'],
];

function lambdaSample(
  rng: Rng,
  p: { memoryMb: number; invocations: number; durationMs: number; maxUsedMb: number },
): DaySample {
  const invocations = Math.round(around(rng, p.invocations, p.invocations * 0.08));
  const durationMs = around(rng, p.durationMs, p.durationMs * 0.1);
  const gbSeconds = invocations * (durationMs / 1000) * (p.memoryMb / 1024);
  return {
    usage: gbSeconds,
    metrics: [
      ['invocations', invocations, 'Count'],
      ['duration_avg_ms', durationMs, 'Milliseconds'],
      ['memory_max_used_mb', around(rng, p.maxUsedMb, p.maxUsedMb * 0.05), 'Megabytes'],
    ],
  };
}

// ---------------------------------------------------------------------------
// Resource builders
// ---------------------------------------------------------------------------

type Base = Pick<ResourceSpec, 'id' | 'name' | 'account' | 'region' | 'createdAt' | 'tags'> &
  Partial<Pick<ResourceSpec, 'waste' | 'decoy' | 'attributes'>>;

function ec2(
  base: Base,
  instanceType: string,
  hourly: number,
  sample: ResourceSpec['sample'],
): ResourceSpec {
  return {
    provider: 'AWS',
    serviceName: 'Amazon Elastic Compute Cloud',
    serviceCategory: 'Compute',
    resourceType: 'Instance',
    skuId: `BoxUsage:${instanceType}`,
    chargeDescription: `$${hourly} per On Demand Linux ${instanceType} Instance Hour`,
    unitPrice: hourly,
    usageUnit: 'Hours',
    sample,
    ...base,
    attributes: { instance_type: instanceType, state: 'running', ...base.attributes },
  };
}

function ebs(
  base: Base,
  volumeType: 'gp2' | 'gp3',
  sizeGb: number,
  attachedTo: string | null,
): ResourceSpec {
  const price = volumeType === 'gp2' ? 0.1 : 0.08;
  return {
    provider: 'AWS',
    serviceName: 'Amazon Elastic Compute Cloud',
    serviceCategory: 'Storage',
    resourceType: 'Volume',
    skuId: `EBS:VolumeUsage.${volumeType}`,
    chargeDescription: `$${price} per GB-month of General Purpose (${volumeType}) provisioned storage`,
    unitPrice: price,
    usageUnit: 'GB-Mo',
    sample: (ctx) => ({ usage: gbMonthsPerDay(sizeGb), metrics: volumeMetrics(ctx.rng, attachedTo !== null) }),
    ...base,
    attributes: {
      volume_type: volumeType,
      size_gb: sizeGb,
      attached_to: attachedTo,
      state: attachedTo ? 'in-use' : 'available',
      ...base.attributes,
    },
  };
}

function snapshot(base: Base, sizeGb: number, sourceVolumeId: string): ResourceSpec {
  return {
    provider: 'AWS',
    serviceName: 'Amazon Elastic Compute Cloud',
    serviceCategory: 'Storage',
    resourceType: 'Snapshot',
    skuId: 'EBS:SnapshotUsage',
    chargeDescription: '$0.05 per GB-month of snapshot data stored',
    unitPrice: 0.05,
    usageUnit: 'GB-Mo',
    sample: () => ({ usage: gbMonthsPerDay(sizeGb) }),
    ...base,
    attributes: { size_gb: sizeGb, source_volume_id: sourceVolumeId, ...base.attributes },
  };
}

function lambda(
  base: Base,
  memoryMb: number,
  profile: { invocations: number; durationMs: number; maxUsedMb: number },
): ResourceSpec {
  return {
    provider: 'AWS',
    serviceName: 'AWS Lambda',
    serviceCategory: 'Compute',
    resourceType: 'Function',
    skuId: 'Lambda-GB-Second',
    chargeDescription: '$0.0000166667 per GB-second',
    unitPrice: 0.0000166667,
    usageUnit: 'GB-Seconds',
    sample: (ctx) => lambdaSample(ctx.rng, { memoryMb, ...profile }),
    ...base,
    attributes: { memory_mb: memoryMb, runtime: 'nodejs22.x', ...base.attributes },
  };
}

function azureDisk(base: Base, sku: string, sizeGb: number, pricePerGbMonth: number, attachedTo: string | null): ResourceSpec {
  return {
    provider: 'Microsoft',
    serviceName: 'Managed Disks',
    serviceCategory: 'Storage',
    resourceType: 'Disk',
    skuId: `Premium_LRS:${sku}`,
    chargeDescription: `Premium SSD Managed Disk ${sku} (${sizeGb} GiB)`,
    unitPrice: pricePerGbMonth,
    usageUnit: 'GB-Mo',
    sample: (ctx) => ({ usage: gbMonthsPerDay(sizeGb), metrics: volumeMetrics(ctx.rng, attachedTo !== null) }),
    ...base,
    attributes: {
      disk_sku: sku,
      size_gb: sizeGb,
      managed_by: attachedTo,
      disk_state: attachedTo ? 'Attached' : 'Unattached',
      ...base.attributes,
    },
  };
}

// ---------------------------------------------------------------------------
// Savings math for planted waste (kept next to the data it describes)
// ---------------------------------------------------------------------------

const monthly = (dailyCost: number) => dailyCost * DAYS_PER_MONTH;
const lambdaMonthly = (memoryMb: number, invocations: number, durationMs: number) =>
  monthly(invocations * (durationMs / 1000) * (memoryMb / 1024) * 0.0000166667);

/** Running 12h on weekdays instead of 24/7 saves 108 of 168 weekly hours. */
const SCHEDULE_SAVINGS_FRACTION = (168 - 60) / 168;

const NAT_BASELINE_GB = 70;
const NAT_SPIKE_GB = 1000;
const NAT_SPIKE_STARTS_DAY = PERIOD_DAYS - 14;
const NAT_PRICE_PER_GB = 0.045;

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

const prodTags = (app: string, team: string) => ({ env: 'prod', app, team, owner: `${team}@acme.example` });
const devTags = (app: string) => ({ env: 'dev', app, team: 'platform', owner: 'platform@acme.example' });

const webInstances = [1, 2, 3].map((n) =>
  ec2(
    { id: `i-0c3f9a1e7b2d4001${n}`, name: `storefront-web-${n}`, account: AWS_PROD, region: 'us-east-1', createdAt: '2025-03-10', tags: prodTags('storefront', 'web') },
    'm5.xlarge',
    0.192,
    busyVm(55, 30_000),
  ),
);

const webVolumes = [1, 2, 3].map((n) =>
  ebs(
    { id: `vol-0a1b2c3d4e5f6001${n}`, name: `storefront-web-${n}-root`, account: AWS_PROD, region: 'us-east-1', createdAt: '2025-03-10', tags: prodTags('storefront', 'web') },
    'gp3',
    100,
    `i-0c3f9a1e7b2d4001${n}`,
  ),
);

const KAFKA_ID = 'i-0d7e1f2a3b4c50021';

const kafkaBroker = ec2(
  {
    id: KAFKA_ID,
    name: 'events-kafka-broker-1',
    account: AWS_PROD,
    region: 'us-east-1',
    createdAt: '2025-01-15',
    tags: prodTags('events', 'data'),
    decoy: 'Low CPU (~4%) but ~500 GB/day of network egress: a network-bound broker, not an idle instance.',
  },
  'm5.xlarge',
  0.192,
  (ctx) => ({ usage: allDay, metrics: vmMetrics(ctx.rng, { businessCpu: 4.5, offHoursCpu: 3.5, networkMb: 500_000 }) }),
);

const kafkaVolumes = [1, 2].map((n) =>
  ebs(
    {
      id: `vol-0b2c3d4e5f6a7002${n}`,
      name: `events-kafka-data-${n}`,
      account: AWS_PROD,
      region: 'us-east-1',
      createdAt: '2025-01-15',
      tags: prodTags('events', 'data'),
      waste: {
        id: 'gp2-to-gp3',
        category: 'storage-modernization',
        title: 'Migrate attached gp2 volumes to gp3',
        monthlySavingsUsd: 1000 * (0.1 - 0.08),
        tolerancePct: 15,
      },
    },
    'gp2',
    1000,
    KAFKA_ID,
  ),
);

const idleWorker = ec2(
  {
    id: 'i-0e8f7a6b5c4d30031',
    name: 'data-export-worker',
    account: AWS_PROD,
    region: 'us-east-1',
    createdAt: '2025-11-12',
    tags: prodTags('data-export', 'data'),
    waste: {
      id: 'idle-ec2',
      category: 'idle-compute',
      title: 'Idle m5.2xlarge running 24/7',
      monthlySavingsUsd: monthly(0.384 * 24),
      tolerancePct: 15,
    },
  },
  'm5.2xlarge',
  0.384,
  (ctx) => ({ usage: allDay, metrics: vmMetrics(ctx.rng, { businessCpu: 1.4, offHoursCpu: 1.1, networkMb: 10, spread: 0.3 }) }),
);

const ordersDb: ResourceSpec = {
  id: 'db-orders-prod',
  name: 'orders-prod',
  provider: 'AWS',
  account: AWS_PROD,
  region: 'us-east-1',
  serviceName: 'Amazon Relational Database Service',
  serviceCategory: 'Databases',
  resourceType: 'DB Instance',
  skuId: 'InstanceUsage:db.r5.large',
  chargeDescription: '$0.25 per RDS db.r5.large instance hour (PostgreSQL)',
  createdAt: '2024-09-01',
  attributes: { instance_class: 'db.r5.large', engine: 'postgres', multi_az: false },
  tags: prodTags('orders', 'web'),
  unitPrice: 0.25,
  usageUnit: 'Hours',
  sample: (ctx) => ({
    usage: allDay,
    metrics: [
      ['cpu_avg_pct', pct(around(ctx.rng, 42, 6)), 'Percent'],
      ['connections_avg', Math.round(around(ctx.rng, 120, 15)), 'Count'],
    ],
  }),
};

const unattachedVolumes = [
  { n: 1, size: 500, created: '2025-08-20', last: 'i-0f00aa11bb22cc331' },
  { n: 2, size: 1000, created: '2025-12-02', last: 'i-0f00aa11bb22cc332' },
].map(({ n, size, created, last }) =>
  ebs(
    {
      id: `vol-0f1e2d3c4b5a6004${n}`,
      name: `migration-scratch-${n}`,
      account: AWS_PROD,
      region: 'us-east-1',
      createdAt: created,
      tags: prodTags('migration', 'data'),
      attributes: { last_attached_instance: last, last_attached_instance_state: 'terminated' },
      waste: {
        id: 'unattached-ebs',
        category: 'unattached-storage',
        title: 'Unattached EBS volumes left behind by terminated instances',
        monthlySavingsUsd: size * 0.1,
        tolerancePct: 10,
      },
    },
    'gp2',
    size,
    null,
  ),
);

const oldSnapshots = Array.from({ length: 12 }, (_, i) => {
  const created = new Date(Date.UTC(2024, 4 + i, 1)).toISOString().slice(0, 10);
  const suffix = String(i + 1).padStart(2, '0');
  return snapshot(
    {
      id: `snap-0c1d2e3f4a5b600${suffix}`,
      name: `nightly-backup-legacy-${suffix}`,
      account: AWS_PROD,
      region: 'us-east-1',
      createdAt: created,
      tags: { ...prodTags('legacy-reporting', 'data'), backup: 'nightly' },
      attributes: { source_volume_exists: false },
      waste: {
        id: 'old-snapshots',
        category: 'stale-snapshot',
        title: 'Year-old snapshots of volumes that no longer exist',
        monthlySavingsUsd: 200 * 0.05,
        tolerancePct: 10,
      },
    },
    200,
    `vol-0dead${suffix}beef0000`,
  );
});

const recentSnapshots = ['2026-09-15', '2026-09-22'].map((created, i) =>
  snapshot(
    {
      id: `snap-0f9e8d7c6b5a400${i + 1}`,
      name: `events-kafka-data-1-weekly-${i + 1}`,
      account: AWS_PROD,
      region: 'us-east-1',
      createdAt: created,
      tags: { ...prodTags('events', 'data'), backup: 'weekly' },
      attributes: { source_volume_exists: true },
      decoy: 'Recent (<30 days) weekly snapshots of a live volume: normal backup hygiene.',
    },
    1000,
    'vol-0b2c3d4e5f6a70021',
  ),
);

const ETL = { memoryMb: 3008, invocations: 50_000, durationMs: 800 };
const etlLambda = lambda(
  {
    id: 'arn:aws:lambda:us-east-1:111111111111:function:etl-transform',
    name: 'etl-transform',
    account: AWS_PROD,
    region: 'us-east-1',
    createdAt: '2025-06-01',
    tags: prodTags('etl', 'data'),
    waste: {
      id: 'oversized-lambda',
      category: 'oversized-function',
      title: 'Lambda allocated 3 GB but never uses more than ~210 MB',
      // Right-sized to 512 MB, assuming duration holds (it may not — hence the wide tolerance).
      monthlySavingsUsd:
        lambdaMonthly(ETL.memoryMb, ETL.invocations, ETL.durationMs) - lambdaMonthly(512, ETL.invocations, ETL.durationMs),
      tolerancePct: 35,
    },
  },
  ETL.memoryMb,
  { invocations: ETL.invocations, durationMs: ETL.durationMs, maxUsedMb: 210 },
);

const apiLambda = lambda(
  { id: 'arn:aws:lambda:us-east-1:111111111111:function:api-handler', name: 'api-handler', account: AWS_PROD, region: 'us-east-1', createdAt: '2025-02-20', tags: prodTags('storefront', 'web') },
  512,
  { invocations: 400_000, durationMs: 120, maxUsedMb: 380 },
);

const mlLambda = lambda(
  {
    id: 'arn:aws:lambda:us-east-1:111111111111:function:ml-feature-builder',
    name: 'ml-feature-builder',
    account: AWS_PROD,
    region: 'us-east-1',
    createdAt: '2025-09-05',
    tags: prodTags('ml', 'data'),
    decoy: 'Allocated 3 GB and peaks around 2.75 GB: large, but correctly sized.',
  },
  3008,
  { invocations: 2_000, durationMs: 9_000, maxUsedMb: 2750 },
);

const natGateway: ResourceSpec = {
  id: 'nat-0a9b8c7d6e5f40051',
  name: 'prod-nat-a',
  provider: 'AWS',
  account: AWS_PROD,
  region: 'us-east-1',
  serviceName: 'Amazon Virtual Private Cloud',
  serviceCategory: 'Networking',
  resourceType: 'NAT Gateway',
  skuId: 'NatGateway-Bytes',
  chargeDescription: '$0.045 per GB Data Processed by NAT Gateways',
  createdAt: '2024-09-01',
  attributes: { subnet: 'subnet-0prod-private-a', vpc: 'vpc-0prod' },
  tags: prodTags('network', 'platform'),
  unitPrice: NAT_PRICE_PER_GB,
  usageUnit: 'GB',
  sample: (ctx) => {
    const spiking = ctx.day >= NAT_SPIKE_STARTS_DAY;
    const gb = spiking ? around(ctx.rng, NAT_SPIKE_GB, 60) : around(ctx.rng, NAT_BASELINE_GB, 8);
    return {
      usage: gb,
      metrics: [
        ['bytes_processed_gb', gb, 'Gigabytes'],
        // Breadcrumb for root cause: S3 traffic routed through NAT instead of a gateway endpoint.
        ['s3_destined_pct', spiking ? around(ctx.rng, 92, 3) : around(ctx.rng, 10, 3), 'Percent'],
      ],
    };
  },
  waste: {
    id: 'nat-spike',
    category: 'cost-anomaly',
    title: 'NAT Gateway data processing jumped ~14x in the last two weeks',
    monthlySavingsUsd: monthly((NAT_SPIKE_GB - NAT_BASELINE_GB) * NAT_PRICE_PER_GB),
    tolerancePct: 40,
  },
};

const assetsBucket: ResourceSpec = {
  id: 'acme-prod-assets',
  name: 'acme-prod-assets',
  provider: 'AWS',
  account: AWS_PROD,
  region: 'us-east-1',
  serviceName: 'Amazon Simple Storage Service',
  serviceCategory: 'Storage',
  resourceType: 'Bucket',
  skuId: 'TimedStorage-ByteHrs',
  chargeDescription: '$0.023 per GB-month of S3 Standard storage',
  createdAt: '2024-09-01',
  attributes: { storage_class: 'STANDARD', lifecycle_rules: 1 },
  tags: prodTags('storefront', 'web'),
  unitPrice: 0.023,
  usageUnit: 'GB-Mo',
  sample: (ctx) => ({ usage: gbMonthsPerDay(5000 + ctx.day * 10) }),
};

const devAlwaysOn = [
  { id: 'i-0a2b3c4d5e6f70061', name: 'dev-api-1', app: 'api' },
  { id: 'i-0a2b3c4d5e6f70062', name: 'dev-worker-1', app: 'worker' },
].map(({ id, name, app }) =>
  ec2(
    {
      id,
      name,
      account: AWS_DEV,
      region: 'us-west-2',
      createdAt: '2025-04-01',
      tags: devTags(app),
      waste: {
        id: 'dev-always-on',
        category: 'schedule-non-prod',
        title: 'Dev instances run 24/7 but are only used during business hours',
        monthlySavingsUsd: monthly(0.34 * 24) * SCHEDULE_SAVINGS_FRACTION,
        tolerancePct: 30,
      },
    },
    'c5.2xlarge',
    0.34,
    (ctx) => ({
      usage: allDay,
      metrics: vmMetrics(ctx.rng, {
        businessCpu: ctx.weekday ? 50 : 1,
        offHoursCpu: 1,
        networkMb: ctx.weekday ? 4_000 : 20,
      }),
    }),
  ),
);

const ciRunner = ec2(
  {
    id: 'i-0b3c4d5e6f7a80071',
    name: 'ci-runner-1',
    account: AWS_DEV,
    region: 'us-west-2',
    createdAt: '2025-04-01',
    tags: { ...devTags('ci'), schedule: 'weekdays-0800-2000' },
    decoy: 'Non-prod, but already scheduled: it only bills ~12 hours on weekdays.',
  },
  'c5.2xlarge',
  0.34,
  (ctx) =>
    ctx.weekday
      ? { usage: 12, metrics: vmMetrics(ctx.rng, { businessCpu: 60, offHoursCpu: 40, networkMb: 8_000 }) }
      : { usage: 0 },
);

const azureVm: ResourceSpec = {
  id: `${AZ_RG}/Microsoft.Compute/virtualMachines/analytics-vm-01`,
  name: 'analytics-vm-01',
  provider: 'Microsoft',
  account: AZ_ANALYTICS,
  region: 'eastus',
  serviceName: 'Virtual Machines',
  serviceCategory: 'Compute',
  resourceType: 'Virtual Machine',
  skuId: 'Standard_D4s_v5',
  chargeDescription: 'D4s v5 Linux virtual machine hour',
  createdAt: '2025-05-12',
  attributes: { vm_size: 'Standard_D4s_v5', power_state: 'running' },
  tags: { env: 'prod', app: 'analytics', team: 'data', owner: 'data@acme.example' },
  unitPrice: 0.192,
  usageUnit: 'Hours',
  sample: busyVm(50, 15_000),
};

const azureOsDisk = azureDisk(
  { id: `${AZ_RG}/Microsoft.Compute/disks/analytics-vm-01-osdisk`, name: 'analytics-vm-01-osdisk', account: AZ_ANALYTICS, region: 'eastus', createdAt: '2025-05-12', tags: { env: 'prod', app: 'analytics', team: 'data' } },
  'P10',
  128,
  0.154,
  azureVm.id,
);

const azureScratchDisk = azureDisk(
  {
    id: `${AZ_RG}/Microsoft.Compute/disks/analytics-scratch-disk`,
    name: 'analytics-scratch-disk',
    account: AZ_ANALYTICS,
    region: 'eastus',
    createdAt: '2025-10-03',
    tags: { env: 'prod', app: 'analytics', team: 'data' },
    waste: {
      id: 'azure-unattached-disk',
      category: 'unattached-storage',
      title: 'Unattached 1 TiB Premium SSD managed disk',
      monthlySavingsUsd: 1024 * 0.132,
      tolerancePct: 10,
    },
  },
  'P30',
  1024,
  0.132,
  null,
);

export const RESOURCES: ResourceSpec[] = [
  ...webInstances,
  ...webVolumes,
  kafkaBroker,
  ...kafkaVolumes,
  idleWorker,
  ordersDb,
  ...unattachedVolumes,
  ...oldSnapshots,
  ...recentSnapshots,
  etlLambda,
  apiLambda,
  mlLambda,
  natGateway,
  assetsBucket,
  ...devAlwaysOn,
  ciRunner,
  azureVm,
  azureOsDisk,
  azureScratchDisk,
];

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

export interface GroundTruthFinding {
  id: string;
  category: FindingCategory;
  title: string;
  resource_ids: string[];
  expected_monthly_savings_usd: number;
  tolerance_pct: number;
}

export interface GroundTruth {
  analysis_date: string;
  period: { start: string; days: number };
  findings: GroundTruthFinding[];
  decoys: { resource_id: string; reason: string }[];
}

export function buildGroundTruth(resources: ResourceSpec[] = RESOURCES): GroundTruth {
  const byId = new Map<string, GroundTruthFinding>();
  for (const r of resources) {
    if (!r.waste) continue;
    const existing = byId.get(r.waste.id);
    if (existing) {
      existing.resource_ids.push(r.id);
      existing.expected_monthly_savings_usd += r.waste.monthlySavingsUsd;
    } else {
      byId.set(r.waste.id, {
        id: r.waste.id,
        category: r.waste.category,
        title: r.waste.title,
        resource_ids: [r.id],
        expected_monthly_savings_usd: r.waste.monthlySavingsUsd,
        tolerance_pct: r.waste.tolerancePct,
      });
    }
  }
  const findings = [...byId.values()].map((f) => ({
    ...f,
    expected_monthly_savings_usd: Math.round(f.expected_monthly_savings_usd * 100) / 100,
  }));
  return {
    analysis_date: ANALYSIS_DATE,
    period: { start: PERIOD_START, days: PERIOD_DAYS },
    findings,
    decoys: resources.filter((r) => r.decoy).map((r) => ({ resource_id: r.id, reason: r.decoy! })),
  };
}
