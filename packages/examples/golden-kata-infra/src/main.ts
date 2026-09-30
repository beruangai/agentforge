import { App } from '@beruangai/common-constructs';
import { ApplicationStage } from './stages/application-stage.js';

const app = new App();

// AgentForge's test deployment of golden-kata: `deploy` runs it as the test
// role in us-east-2 (.env.integ), and its name falls under the role's
// `agentforge-example-*` patterns.
new ApplicationStage(app, 'agentforge-example-golden-kata', {
  env: {
    account: '913756569129', // AgentForge account
    region: 'us-east-2', // Ohio is integ region
  },
});

app.synth();
