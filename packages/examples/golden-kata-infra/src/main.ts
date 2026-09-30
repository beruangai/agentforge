import { App } from '@beruangai/common-constructs';
import { ApplicationStage } from './stages/application-stage.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const app = new App();

// AgentForge's test deployment of golden-kata: `deploy` runs it as the test
// role in us-east-2 (.env.integ), and its name falls under the role's
// `agentforge-example-*` patterns.
new ApplicationStage(app, 'agentforge-example-golden-kata', {
  env: {
    account: required('CDK_DEFAULT_ACCOUNT'),
    region: required('CDK_DEFAULT_REGION'),
  },
});

app.synth();
