import { App } from '@beruangai/common-constructs';
import { ApplicationStage } from './stages/application-stage.js';

const app = new App();

// AgentForge's test deployment of golden-kata, pinned to its account and
// us-east-2; its name falls under the test role's `agentforge-example-*`
// patterns, which the e2e suite reads it through.
new ApplicationStage(app, 'agentforge-example-golden-kata', {
  env: {
    account: '913756569129', // AgentForge account
    region: 'us-east-2', // Ohio is integ region
  },
});

app.synth();
