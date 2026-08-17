import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "../components/ui/sonner";
import { TOOLTIP_DELAY_MS, TooltipProvider } from "../components/ui/tooltip";
import { baseMetaData } from "./metadata";
import { BotIdClient } from "botid/client";
import { webEnv } from "@/env/web";
import { Inter } from "next/font/google";
import { WebOnlyScripts } from "@/components/providers/web-only-scripts";

const siteFont = Inter({ subsets: ["latin"] });

export const metadata = baseMetaData;

const protectedRoutes = [
	{
		path: "/none",
		method: "GET",
	},
];

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<BotIdClient protect={protectedRoutes} />
			</head>
			<body className={`${siteFont.className} font-sans antialiased`}>
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					disableTransitionOnChange={true}
				>
					<TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
						<Toaster />
						<WebOnlyScripts
							dataBuddyClientId="UP-Wcoy5arxFeK7oyjMMZ"
							disabled={webEnv.NODE_ENV === "development"}
						/>
						{children}
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
