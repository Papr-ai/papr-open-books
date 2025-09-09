'use client';

/**
 * Real-time subscription context that replaces polling with instant updates
 * This provides subscription and usage data with real-time notifications
 */

import React, { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { useSession } from 'next-auth/react';
import { useRealtimeUpdates } from '@/lib/db/realtime-client';
import type { SubscriptionPlan } from '@/lib/subscription/types';

interface SubscriptionData {
  subscriptionStatus: string;
  subscriptionPlan: string;
  hasActiveSubscription: boolean;
  subscriptionCurrentPeriodEnd?: Date;
  plan?: SubscriptionPlan;
}

interface UsageData {
  basicInteractions: { current: number; limit: number; percentage: number };
  premiumInteractions: { current: number; limit: number; percentage: number };
  memoriesAdded: { current: number; limit: number; percentage: number };
  memoriesSearched: { current: number; limit: number; percentage: number };
  voiceChats: { current: number; limit: number; percentage: number };
  videosGenerated: { current: number; limit: number; percentage: number };
  plan: string;
}

interface SubscriptionContextValue {
  // Subscription data
  subscription: SubscriptionData;
  subscriptionLoading: boolean;
  subscriptionError?: string;
  
  // Usage data
  usage: UsageData | null;
  usageLoading: boolean;
  usageError?: string;
  
  // Real-time connection status
  isConnected: boolean;
  
  // Manual refresh functions
  refreshSubscription: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  
  // Helper functions
  canUsePremiumModels: () => boolean;
  shouldShowUpgrade: () => boolean;
}

const SubscriptionContext = createContext<SubscriptionContextValue | undefined>(undefined);

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const { data: session, status: sessionStatus } = useSession();
  
  // Subscription state
  const [subscription, setSubscription] = useState<SubscriptionData>({
    subscriptionStatus: 'free',
    subscriptionPlan: 'free',
    hasActiveSubscription: false,
  });
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);
  const [subscriptionError, setSubscriptionError] = useState<string>();
  
  // Usage state
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState<string>();
  
  // Track sync attempts to avoid duplicate Stripe syncs
  const syncAttemptedRef = useRef(false);

  // Fetch subscription data
  const fetchSubscription = async (shouldSync: boolean = false) => {
    if (!session?.user) return;

    try {
      setSubscriptionLoading(true);
      setSubscriptionError(undefined);

      // Sync with Stripe if requested and not already attempted
      if (shouldSync && !syncAttemptedRef.current) {
        syncAttemptedRef.current = true;
        try {
          await fetch('/api/subscription/sync', { method: 'POST' });
          console.log('[Subscription Context] Synced with Stripe');
        } catch (syncError) {
          console.warn('[Subscription Context] Sync failed, continuing with cached data:', syncError);
        }
      }

      const response = await fetch('/api/user/subscription');
      if (!response.ok) {
        throw new Error('Failed to fetch subscription status');
      }
      
      const data = await response.json();
      setSubscription(data);
      console.log('[Subscription Context] Updated subscription data:', data);
      
      // Trigger a refresh of the subscription data in other parts of the app
      // This helps ensure chat permissions are updated with latest subscription
      window.dispatchEvent(new CustomEvent('subscriptionUpdated', { detail: data }));
    } catch (error) {
      console.error('[Subscription Context] Error fetching subscription:', error);
      setSubscriptionError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setSubscriptionLoading(false);
    }
  };

  // Fetch usage data
  const fetchUsage = async () => {
    if (!session?.user) return;

    try {
      setUsageLoading(true);
      setUsageError(undefined);

      const response = await fetch('/api/user/usage');
      if (!response.ok) {
        throw new Error('Failed to fetch usage data');
      }
      
      const data = await response.json();
      setUsage(data);
      console.log('[Subscription Context] Updated usage data:', data);
    } catch (error) {
      console.error('[Subscription Context] Error fetching usage:', error);
      setUsageError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setUsageLoading(false);
    }
  };

  // Initial data loading
  useEffect(() => {
    // Reset sync attempt when session changes
    syncAttemptedRef.current = false;
    
    if (sessionStatus === 'loading') {
      return;
    }
    
    if (!session?.user) {
      // Set default free plan data
      setSubscription({
        subscriptionStatus: 'free',
        subscriptionPlan: 'free',
        hasActiveSubscription: false,
      });
      setUsage(null);
      setSubscriptionLoading(false);
      setUsageLoading(false);
      return;
    }

    // Load initial data
    fetchSubscription(false);
    fetchUsage();
  }, [session?.user, sessionStatus]);

  // Real-time updates
  const { isConnected } = useRealtimeUpdates((update) => {
    console.log('[Subscription Context] Received real-time update:', update);
    
    if (update.table === 'subscription') {
      // Refresh subscription data when subscription changes
      fetchSubscription(false);
    } else if (update.table === 'usage') {
      // Refresh usage data when usage changes
      fetchUsage();
    }
  });

  // Helper functions
  const canUsePremiumModels = (): boolean => {
    return subscription.hasActiveSubscription && subscription.subscriptionPlan !== 'free';
  };

  const shouldShowUpgrade = (): boolean => {
    if (!usage || subscription.subscriptionPlan !== 'free') return false;
    
    // Show upgrade if any usage is at 80% or higher
    const usageTypes = [
      usage.basicInteractions,
      usage.premiumInteractions,
      usage.memoriesAdded,
      usage.memoriesSearched,
      usage.voiceChats,
      usage.videosGenerated,
    ];
    
    return usageTypes.some(usage => usage.percentage >= 80);
  };

  const contextValue: SubscriptionContextValue = {
    // Subscription data
    subscription,
    subscriptionLoading,
    subscriptionError,
    
    // Usage data
    usage,
    usageLoading,
    usageError,
    
    // Real-time status
    isConnected,
    
    // Manual refresh functions
    refreshSubscription: () => fetchSubscription(true), // Force sync with Stripe
    refreshUsage: fetchUsage,
    
    // Helper functions
    canUsePremiumModels,
    shouldShowUpgrade,
  };

  return (
    <SubscriptionContext.Provider value={contextValue}>
      {children}
    </SubscriptionContext.Provider>
  );
}

// Hook to use subscription context
export function useSubscription() {
  const context = useContext(SubscriptionContext);
  if (context === undefined) {
    throw new Error('useSubscription must be used within a SubscriptionProvider');
  }
  return context;
}

// Backward compatibility hook that matches the old useSubscription interface
export function useSubscriptionLegacy(syncWithStripe: boolean = false): {
  subscriptionStatus: string;
  subscriptionPlan: string;
  hasActiveSubscription: boolean;
  plan?: SubscriptionPlan;
  loading: boolean;
  error?: string;
} {
  const context = useSubscription();
  
  // Trigger sync if requested (but only once per session)
  useEffect(() => {
    if (syncWithStripe && context.subscription.subscriptionStatus !== 'free') {
      context.refreshSubscription();
    }
  }, [syncWithStripe]);
  
  return {
    subscriptionStatus: context.subscription.subscriptionStatus,
    subscriptionPlan: context.subscription.subscriptionPlan,
    hasActiveSubscription: context.subscription.hasActiveSubscription,
    plan: context.subscription.plan,
    loading: context.subscriptionLoading,
    error: context.subscriptionError,
  };
}

// Helper hook for premium model access
export function useCanUsePremiumModels(): boolean {
  const { canUsePremiumModels } = useSubscription();
  return canUsePremiumModels();
}

// Helper hook for usage data
export function useUsageData() {
  const { usage, usageLoading, usageError, refreshUsage } = useSubscription();
  return { usage, loading: usageLoading, error: usageError, refresh: refreshUsage };
}

// Helper hook for upgrade prompts
export function useUpgradePrompt() {
  const { shouldShowUpgrade, subscription, usage } = useSubscription();
  return {
    shouldShow: shouldShowUpgrade(),
    currentPlan: subscription.subscriptionPlan,
    usageData: usage,
  };
}
