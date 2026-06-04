/**
 * Reads the stack name and region from ../samconfig.toml,
 * resolves the FrontendBucket output, then syncs dist/ to S3.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Parse samconfig.toml — minimal TOML: find stack_name and region under [default.global.parameters]
const samconfig = readFileSync(resolve(root, 'samconfig.toml'), 'utf8');
const stackName = samconfig.match(/stack_name\s*=\s*"([^"]+)"/)?.[1];
const region    = samconfig.match(/region\s*=\s*"([^"]+)"/)?.[1] ?? 'us-east-1';

if (!stackName) {
  console.error('Could not find stack_name in samconfig.toml');
  process.exit(1);
}

console.log(`Stack: ${stackName}  Region: ${region}`);

// Get FrontendBucket from stack outputs
const outputsJson = execSync(
  `aws cloudformation describe-stacks --stack-name ${stackName} --region ${region} ` +
  `--query "Stacks[0].Outputs" --output json`,
  { encoding: 'utf8' }
);

const outputs  = JSON.parse(outputsJson);
const bucket   = outputs.find(o => o.OutputKey === 'FrontendBucket')?.OutputValue;

if (!bucket) {
  console.error('FrontendBucket output not found in stack. Run sam deploy first.');
  process.exit(1);
}

console.log(`Syncing dist/ → s3://${bucket}`);

execSync(
  `aws s3 sync dist s3://${bucket} --delete ` +
  `--cache-control "no-store, no-cache, must-revalidate" --region ${region}`,
  { stdio: 'inherit' }
);

console.log('Deploy complete.');
