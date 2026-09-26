import { betterAuth } from 'better-auth';
import { anonymous } from 'better-auth/plugins';

// Schema generator input. The runtime adapter is created from env.APP per request.
export const auth = betterAuth({ plugins: [anonymous()] });
