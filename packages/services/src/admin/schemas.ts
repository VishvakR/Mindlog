import { z } from 'zod';

export const superuserCredentialsSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.trim().toLowerCase()),
  password: z.string().min(10).max(256),
});
export type SuperuserCredentials = z.infer<typeof superuserCredentialsSchema>;

/** Login takes any password; length rules apply when it is set. */
export const authWithPasswordBodySchema = z.object({
  email: z.string().max(254),
  password: z.string().max(256),
});
export type AuthWithPasswordBody = z.infer<typeof authWithPasswordBodySchema>;

export const superuserSchema = z.object({
  email: z.string(),
  created: z.string(),
  updated: z.string(),
});
export type Superuser = z.infer<typeof superuserSchema>;

export const authResultSchema = z.object({ token: z.string(), superuser: superuserSchema });
export type AuthResult = z.infer<typeof authResultSchema>;
