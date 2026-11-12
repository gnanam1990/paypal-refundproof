import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrateUp } from '../../src/db/migrate';
import { PgCluster } from './pg-cluster';

let cluster: PgCluster | undefined;

export default async function setup(project: TestProject) {
  cluster = await PgCluster.start();
  const c = new pg.Client({ connectionString: cluster.url() });
  await c.connect();
  await c.query('create database refundproof_template');
  await c.end();
  await migrateUp(cluster.url('refundproof_template'));
  project.provide('pgAdminUrl', cluster.url());
  project.provide('pgTemplate', 'refundproof_template');
  return async () => {
    await cluster?.destroy();
  };
}
