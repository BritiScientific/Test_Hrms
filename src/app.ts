import express from 'express';
import { errorHandler } from './middleware/error-handler';
import { requestId } from './middleware/http';
import { authRouter } from './modules/auth/auth.routes';
import { employeeRouter } from './modules/employees/employee.routes';
import { leaveConfigRouter } from './modules/leave/leave-config.routes';
import { leaveRouter } from './modules/leave/leave.routes';
import { onboardingRouter } from './modules/onboarding/onboarding.routes';
import { organizationRouter } from './modules/organization/organization.routes';
import { registerLeaveWorkflow } from './modules/leave/leave.workflow-handler';
import { rbacRouter } from './modules/rbac/rbac.routes';
import { workflowRouter } from './modules/workflow/workflow.routes';

export function createApp() {
  // Register every module that uses the workflow engine.
  registerLeaveWorkflow();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestId);
  app.use(express.json({ limit: '100kb' }));
  // Login/activation are rate-limited in-process. In production also add helmet()
  // and a shared limiter at the gateway. No CORS: the SPA is served same-origin.
  app.use((_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const v1 = express.Router();
  v1.use(authRouter);
  v1.use(onboardingRouter);
  v1.use(organizationRouter);
  v1.use(employeeRouter);
  v1.use(rbacRouter);
  v1.use(workflowRouter);
  v1.use(leaveConfigRouter);
  v1.use(leaveRouter);
  app.use('/api/v1', v1);

  app.use((_req, res) => res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Not found' } }));
  app.use(errorHandler);
  return app;
}
