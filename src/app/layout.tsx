import type { Metadata } from "next";

// The app itself is the static page in public/ (served at /app). Next only hosts it and the API.
export const metadata: Metadata = {
  title: "sWallet",
  description: "Finanzas, clientes, proyectos y tareas de sCode Digital Solutions"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
