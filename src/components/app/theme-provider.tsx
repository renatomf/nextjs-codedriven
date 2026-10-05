"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ThemeProvider as NextThemesProvider } from "next-themes";

const LIGHT_ONLY_PATHS = ["/", "/login", "/register"];

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  const pathname = usePathname();

  // Landing and auth pages are designed light-only (no toggle there); the app
  // routes follow the theme.
  const lightOnly = LIGHT_ONLY_PATHS.includes(pathname);

  return (
    <NextThemesProvider
      forcedTheme={lightOnly ? "light" : undefined}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
