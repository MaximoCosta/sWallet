import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { Role } from "@prisma/client";
import { z } from "zod";
import { isValidLoginPassword, LoginConfigError, loginEmailFor, matchAllowedUsername } from "@/lib/login-credentials";

const credentialsSchema = z.object({
  credential: z.string().min(3).max(80),
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
        credential: { label: "Usuario", type: "text" },
        password: { label: "Password", type: "password" }
      },
      async authorize(rawCredentials) {
        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) return null;

        const allowedUsername = resolveAllowedUsername(parsed.data.credential, parsed.data.password);
        if (!allowedUsername) return null;

        return {
          id: normalizeCredential(allowedUsername),
          email: loginEmailFor(allowedUsername),
          name: allowedUsername,
          image: null,
          role: "admin"
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

function resolveAllowedUsername(credential: string, password: string) {
  try {
    if (!isValidLoginPassword(password)) return null;
  } catch (error) {
    if (error instanceof LoginConfigError) {
      console.error(error.message);
      return null;
    }
    throw error;
  }

  return matchAllowedUsername(credential);
}

function normalizeCredential(value: string) {
  return value.trim().toLowerCase();
}

function resolveRole(role: unknown): Role {
  const allowedRoles = ["admin", "finanzas", "project_manager", "desarrollador", "marketing", "solo_lectura", "cliente"];
  return allowedRoles.includes(String(role)) ? (role as Role) : "solo_lectura";
}
