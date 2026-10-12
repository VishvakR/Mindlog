import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError } from '@/lib/api';
import { router } from './router';
import './index.css';

const queries = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) =>
        !(error instanceof ApiError && error.problem.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queries}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
