import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { Role } from "@prisma/client";
import { z } from "zod";
import { AuthConfigError, signInWithPassword } from "@/lib/supabase-auth";

const credentialsSchema = z.object({
  credential: z.string().email().max(120),
  password: z.string().min(8)
});

export const authConfig = {
  session: {
    strategy: "jwt"
  },
  pages: {
    signIn: "/login"
  },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        credential: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      async authorize(rawCredentials) {
        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) return null;

        const account = await signInSupabase(parsed.data.credential, parsed.data.password);
        if (!account) return null;

        return {
          id: account.id,
          email: account.email,
          name: account.name,
          image: account.avatar || null,
          role: account.role
        };
      }
    })
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.role = resolveRole(token.role);
      }
      return session;
    }
  }
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

// Same accounts as the static app: Supabase Auth email + password.
async function signInSupabase(email: string, password: string) {
  try {
    const session = await signInWithPassword(email, password);
    return session?.account ?? null;
  } catch (error) {
    if (error instanceof AuthConfigError) {
      console.error(error.message);
      return null;
    }
    throw error;
  }
}

function resolveRole(role: unknown): Role {
  const allowedRoles = ["admin", "finanzas", "project_manager", "desarrollador", "marketing", "solo_lectura", "cliente"];
  return allowedRoles.includes(String(role)) ? (role as Role) : "solo_lectura";
}
