import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../../src/auth/auth.service';
import { bodyOf } from './e2e-app';

export interface LoggedInUser {
  id: string;
  email: string;
  accessToken: string;
}

const DEFAULT_PASSWORD = 'password123';

// Registers (which also creates the user's channel), confirms the email with the
// token captured from the MailService and logs in.
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = DEFAULT_PASSWORD,
): Promise<LoggedInUser> {
  const mailService = app.get(AuthService)['mailService'];
  let confirmationToken = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  const registered = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return {
    id: bodyOf<{ id: string }>(registered).id,
    email,
    accessToken: bodyOf<{ access_token: string }>(login).access_token,
  };
}
