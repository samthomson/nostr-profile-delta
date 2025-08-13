// We need to handle optional metadata fields that may be undefined

import { useSeoMeta } from '@unhead/react';
import { useState, useCallback, useEffect } from 'react';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { nip19 } from 'nostr-tools';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Info, AlertCircle, X, RefreshCw, ArrowRight } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoginArea } from '@/components/auth/LoginArea';
import { useToast } from '@/hooks/useToast';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Add TypeScript interface for window.nostr
declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (event: unknown) => Promise<unknown>;
      getRelays: () => Promise<Record<string, { read: boolean; write: boolean }>>;
    };
  }
}

// Default set of relays to start with
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://purplepag.es',
];

interface ProfileMetadata {
  name?: string;
  display_name?: string;
  picture?: string;
  banner?: string;
  about?: string;
  website?: string;
  nip05?: string;
  lud06?: string;
  lud16?: string;
  [key: string]: string | undefined;
}

interface CheckedProfile {
  relayUrl: string;
  event: {
    pubkey: string;
    content: string;
    created_at: number;
    tags: string[][];
    id: string;
    sig: string;
    kind: number;
  };
  metadata?: ProfileMetadata;
  timestamp: number;
}

interface ErrorProfile {
  relayUrl: string;
  error: string;
}

interface UncheckedProfile {
  relayUrl: string;
  notChecked: boolean;
}

type ProfileData = CheckedProfile | ErrorProfile | UncheckedProfile;

interface RelaySet {
  label: string;
  relays: string[];
}

const Index = () => {
  useSeoMeta({
    title: 'Nostr Profile Delta - Track Profile Changes Across Relays',
    description: 'Find outdated profile information across the Nostr network and identify relay inconsistencies.',
  });

  const { toast } = useToast();
  const { nostr } = useNostr();
  const [npubInput, setNpubInput] = useState('');
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [customRelays, setCustomRelays] = useState<string[]>([]);
  const [customRelayInput, setCustomRelayInput] = useState('');
  const [relaySets, setRelaySets] = useState<RelaySet[]>([
    { label: 'Default', relays: DEFAULT_RELAYS },
    { label: 'Custom', relays: [] },
    { label: 'User\'s Relays', relays: [] },
  ]);
  
  // State for per-relay refresh and diff dialog
  const [refreshingRelays, setRefreshingRelays] = useState<Record<string, boolean>>({});
  const [diffDialogOpen, setDiffDialogOpen] = useState(false);
  const [currentDiff, setCurrentDiff] = useState<{ profile: ProfileData, fields: string[] } | null>(null);
  const [mostRecentTimestamp, setMostRecentTimestamp] = useState<number | null>(null);

  // Effect to get user's pubkey from extension when available
  useEffect(() => {
    const checkNostrExtension = async () => {
      try {
        if ('nostr' in window && window.nostr) {
          // Get the pubkey from the extension
          const pubkey = await window.nostr.getPublicKey();
          if (pubkey) {
            try {
              // Convert to npub for display
              const npub = nip19.npubEncode(pubkey);
              setNpubInput(npub);
              
              // Also set the pubkey directly to trigger the query
              setPubkey(pubkey);
            } catch (error) {
              console.error('Error encoding pubkey to npub:', error);
            }
          }
        }
      } catch (error) {
        console.error('Error accessing Nostr extension:', error);
      }
    };
    
    checkNostrExtension();
  }, []);

  // Query to get the user's relays (kind 10002)
  const { data: userRelays, isLoading: isLoadingUserRelays } = useQuery({
    queryKey: ['user-relays', pubkey],
    queryFn: async ({ signal }) => {
      if (!pubkey) return [];
      
      const events = await nostr.query(
        [{ kinds: [10002], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }
      );
      
      if (events && events.length > 0) {
        const relayEvent = events[0];
        const relayList: string[] = [];
        
        // Extract relay URLs from tags
        relayEvent.tags.forEach(tag => {
          if (tag[0] === 'r') {
            relayList.push(tag[1]);
          }
        });
        
        return relayList;
      }
      
      return [];
    },
    enabled: !!pubkey,
    retry: 2,
  });

  // Update the user's relays in the relay sets
  useEffect(() => {
    if (userRelays && userRelays.length > 0) {
      setRelaySets(prev => {
        const updated = [...prev];
        const userRelaySetIndex = updated.findIndex(set => set.label === 'User\'s Relays');
        if (userRelaySetIndex !== -1) {
          updated[userRelaySetIndex] = {
            ...updated[userRelaySetIndex],
            relays: userRelays
          };
        }
        return updated;
      });
    }
  }, [userRelays]);

  // Update custom relays in the relay sets
  useEffect(() => {
    setRelaySets(prev => {
      const updated = [...prev];
      const customRelaySetIndex = updated.findIndex(set => set.label === 'Custom');
      if (customRelaySetIndex !== -1) {
        updated[customRelaySetIndex] = {
          ...updated[customRelaySetIndex],
          relays: customRelays
        };
      }
      return updated;
    });
  }, [customRelays]);

  // Query to get the user's profile (kind 0) from all relays individually
  const { data: profilesData, isLoading: isLoadingProfiles, refetch: refetchProfiles } = useQuery({
    queryKey: ['profiles', pubkey, relaySets, userRelays],
    queryFn: async ({ signal }) => {
      if (!pubkey) return [];
      
      // Get all unique relays from all sets
      const allRelays = [...new Set(relaySets.flatMap(set => set.relays))];
      
      if (allRelays.length === 0) {
        return [];
      }
      
      // Track which relays we've checked and which ones haven't been checked yet
      const checkedRelays: string[] = [];
      const uncheckedRelays: string[] = [];
      
      // Only auto-check the user's own relays
      allRelays.forEach(relay => {
        if (userRelays && userRelays.includes(relay)) {
          checkedRelays.push(relay);
        } else {
          uncheckedRelays.push(relay);
        }
      });
      
      // Create an initial array of placeholder results for unchecked relays
      const uncheckedResults = uncheckedRelays.map(relayUrl => ({
        relayUrl,
        notChecked: true,
      }));
      
      // Query only the user's relays initially
      const profilePromises = checkedRelays.map(async (relayUrl) => {
        try {
          // Query directly from the main nostr pool with a relay-specific filter
          const events = await nostr.query(
            [{ kinds: [0], authors: [pubkey], limit: 1 }],
            { 
              signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
              relays: [relayUrl]  // Specify which relay to query
            }
          );
          
          if (events && events.length > 0) {
            const event = events[0];
            let metadata: ProfileMetadata | undefined;
            try {
              metadata = JSON.parse(event.content) as ProfileMetadata;
            } catch (error) {
              console.error("Failed to parse metadata:", error);
              metadata = undefined;
            }
            
            return {
              relayUrl,
              event,
              metadata,
              timestamp: event.created_at,
            };
          }
          
          return {
            relayUrl,
            error: 'No profile found',
          };
        } catch (error) {
          return {
            relayUrl,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      });
      
      const checkedResults = await Promise.all(profilePromises);
      
      // Combine checked and unchecked results
      const results = [...checkedResults, ...uncheckedResults];
      
      // Sort alphabetically by relay URL, with unchecked relays at the end
      return results.sort((a, b) => {
        if ('notChecked' in a) return 1;
        if ('notChecked' in b) return -1;
        return a.relayUrl.localeCompare(b.relayUrl);
      });
    },
    enabled: !!pubkey && relaySets.some(set => set.relays.length > 0) && !!userRelays,
    retry: 2,
  });

  // Handle npub submission
  const handleSubmitNpub = useCallback(() => {
    try {
      let parsedPubkey = '';
      
      // Check if the input is already a hex pubkey
      if (/^[0-9a-f]{64}$/i.test(npubInput)) {
        parsedPubkey = npubInput;
      } else {
        // Try to decode as npub
        try {
          const decoded = nip19.decode(npubInput);
          if (decoded.type === 'npub') {
            parsedPubkey = decoded.data;
          } else if (decoded.type === 'nprofile') {
            parsedPubkey = decoded.data.pubkey;
          }
        } catch (error) {
          console.error("Failed to decode npub:", error);
          throw new Error('Invalid npub format');
        }
      }
      
      if (!parsedPubkey) {
        throw new Error('Could not parse pubkey');
      }
      
      setPubkey(parsedPubkey);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Invalid input',
        variant: 'destructive',
      });
    }
  }, [npubInput, toast]);

  // Handle adding a custom relay
  const handleAddRelay = useCallback(() => {
    if (!customRelayInput.trim()) return;
    
    const relayUrl = customRelayInput.trim();
    if (!relayUrl.startsWith('wss://')) {
      toast({
        title: 'Invalid relay URL',
        description: 'Relay URL must start with wss://',
        variant: 'destructive',
      });
      return;
    }
    
    if (customRelays.includes(relayUrl)) {
      toast({
        title: 'Relay already added',
        description: 'This relay is already in your custom list',
        variant: 'destructive',
      });
      return;
    }
    
    setCustomRelays(prev => [...prev, relayUrl]);
    setCustomRelayInput('');
    
    toast({
      title: 'Relay added',
      description: `Added ${relayUrl} to custom relays`,
    });
  }, [customRelayInput, customRelays, toast]);

  // Type guard to check if profile is a checked profile
  const isCheckedProfile = (p: ProfileData): p is CheckedProfile => 
    'timestamp' in p && !('error' in p) && !('notChecked' in p);
  
  // Find the most recent profile - only consider profiles that have been checked and have timestamps
  const checkedProfiles = profilesData?.filter(isCheckedProfile) || [];
  const mostRecentProfile = checkedProfiles.sort((a, b) => b.timestamp - a.timestamp)[0]?.metadata;

  // Determine if a profile is outdated compared to the most recent one
  const isOutdatedProfile = (profile: ProfileData) => {
    if (!mostRecentProfile || !isCheckedProfile(profile) || !profile.metadata) return false;
    
    // Check if any field is different from the most recent profile
    const fields = ['name', 'display_name', 'picture', 'banner', 'about', 'website', 'nip05', 'lud06', 'lud16'];
    
    return fields.some(field => {
      return mostRecentProfile?.[field] !== profile.metadata?.[field] && 
        (mostRecentProfile?.[field] || profile.metadata?.[field]); // Ensure at least one is non-empty
    });
  };

  // Get all relays with outdated profiles
  const outdatedRelays = profilesData?.filter(profile => isOutdatedProfile(profile)) || [];
  
  // Find the most recent timestamp
  useEffect(() => {
    if (profilesData && profilesData.length > 0) {
      const timestamps = profilesData
        .filter(profile => profile.timestamp !== undefined)
        .map(profile => profile.timestamp as number);
      
      if (timestamps.length > 0) {
        setMostRecentTimestamp(Math.max(...timestamps));
      }
    }
  }, [profilesData]);
  
  // Function to refresh a single relay profile
  // Distinguishes between "No profile found" (not an error) and actual errors
  const refreshRelayProfile = async (relayUrl: string) => {
    if (!pubkey) return;
    
    // Set loading state for this relay
    setRefreshingRelays(prev => ({ ...prev, [relayUrl]: true }));
    
    try {
      const events = await nostr.query(
        [{ kinds: [0], authors: [pubkey], limit: 1 }],
        { 
          signal: AbortSignal.timeout(5000),
          relays: [relayUrl]
        }
      );
      
      if (events && events.length > 0) {
        const event = events[0];
        let metadata: ProfileMetadata | undefined;
        try {
          metadata = JSON.parse(event.content) as ProfileMetadata;
        } catch (error) {
          console.error("Failed to parse metadata:", error);
          metadata = undefined;
        }
        
        // Update the profile in the data
        if (profilesData) {
          const updatedProfiles = [...profilesData];
          const profileIndex = updatedProfiles.findIndex(p => p.relayUrl === relayUrl);
          if (profileIndex !== -1) {
            updatedProfiles[profileIndex] = {
              relayUrl,
              event,
              metadata,
              timestamp: event.created_at,
            };
            
            // Sort by timestamp again
            updatedProfiles.sort((a, b) => {
              if (!a.timestamp) return 1;
              if (!b.timestamp) return -1;
              return b.timestamp - a.timestamp;
            });
            
            // Find the new most recent timestamp
            const timestamps = updatedProfiles
              .filter(profile => profile.timestamp !== undefined)
              .map(profile => profile.timestamp as number);
            
            if (timestamps.length > 0) {
              setMostRecentTimestamp(Math.max(...timestamps));
            }
          }
        }
        
        toast({
          title: 'Relay Updated',
          description: `Successfully refreshed profile from ${relayUrl}`,
        });
      } else {
        toast({
          title: 'No Profile Found',
          description: `Couldn't find a profile on ${relayUrl}`,
        });
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: `Failed to refresh profile from ${relayUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: 'destructive'
      });
    } finally {
      // Clear loading state for this relay
      setRefreshingRelays(prev => ({ ...prev, [relayUrl]: false }));
      
      // Refetch all profiles to ensure consistency
      refetchProfiles();
    }
  };
  
  // Function to show difference dialog
  const showDiffDialog = (profile: ProfileData) => {
    if (!mostRecentProfile || !profile.metadata) return;
    
    const metadata = profile.metadata;
    const diffFields = ['name', 'display_name', 'picture', 'banner', 'about', 'website', 'nip05', 'lud06', 'lud16']
      .filter(field => mostRecentProfile?.[field] !== metadata[field] && 
        (mostRecentProfile?.[field] || metadata[field]));
    
    setCurrentDiff({ profile, fields: diffFields });
    setDiffDialogOpen(true);
  };

  // Render the profile content
  const renderProfileContent = (profile: ProfileData) => {
    if (!profile.metadata) {
      return profile.error ? (
        <span className="text-destructive">{profile.error}</span>
      ) : (
        <span className="text-muted-foreground">No data</span>
      );
    }
    
    return (
      <div className="flex items-center gap-2">
        {profile.metadata.picture && (
          <img 
            src={profile.metadata.picture} 
            alt="Profile" 
            className="w-8 h-8 rounded-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).src = 'https://via.placeholder.com/150';
            }}
          />
        )}
        <span className="font-medium">
          {profile.metadata.display_name ?? profile.metadata.name ?? 'Unnamed'}
        </span>
      </div>
    );
  };
  
  // Render the differences button
  const renderDifferencesButton = (profile: ProfileData, outdated: boolean) => {
    if (!outdated || !mostRecentProfile || !profile.metadata) {
      return null;
    }
    
    return (
      <Button 
        variant="outline" 
        size="sm"
        className="text-xs"
        onClick={() => showDiffDialog(profile)}
      >
        <Info className="h-4 w-4 mr-1" /> View Differences
      </Button>
    );
  };

  return (
    <div className="min-h-screen p-4 md:p-8 bg-background">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold">Nostr Profile Delta</h1>
            <p className="text-muted-foreground">
              Track profile changes across the Nostr network
            </p>
          </div>
          <LoginArea className="max-w-60" />
        </header>

        <Separator />

        <Card>
          <CardHeader>
            <CardTitle>Enter a Nostr Public Key</CardTitle>
            <CardDescription>
              Enter an npub or hex pubkey to check their profile across different relays
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder="npub1..."
                value={npubInput}
                onChange={(e) => setNpubInput(e.target.value)}
                className="flex-1"
              />
              <Button onClick={handleSubmitNpub}>Check</Button>
            </div>
          </CardContent>
        </Card>

        {pubkey && (
          <div className="space-y-6">


            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Relay Status</CardTitle>
                  <CardDescription>
                    {pubkey && (
                      <span className="font-mono text-xs">
                        {pubkey}
                      </span>
                    )}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {outdatedRelays.length > 0 && (
                    <Badge variant="destructive">
                      {outdatedRelays.length} Outdated
                    </Badge>
                  )}
                  {profilesData && profilesData.filter(p => 'error' in p).length > 0 && (
                    <Badge variant="secondary" className="bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                      {profilesData.filter(p => 'error' in p).length} Issues
                    </Badge>
                  )}
                  <Button onClick={() => refetchProfiles()} variant="outline" size="sm">
                    Refresh All
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {!profilesData || profilesData.length === 0 ? (
                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>No profiles found</AlertTitle>
                      <AlertDescription>
                        Could not find any profiles for this pubkey on the configured relays.
                      </AlertDescription>
                    </Alert>
                  ) : isLoadingProfiles ? (
                    <div className="space-y-4">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="flex items-start space-x-4">
                          <Skeleton className="h-12 w-12 rounded-full" />
                          <div className="space-y-2 flex-1">
                            <Skeleton className="h-4 w-[250px]" />
                            <Skeleton className="h-4 w-[200px]" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div>
                      {outdatedRelays.length > 0 && (
                        <Alert variant="destructive" className="mb-4">
                          <AlertCircle className="h-4 w-4" />
                          <AlertTitle>Outdated Profiles Detected</AlertTitle>
                          <AlertDescription>
                            Found {outdatedRelays.length} relays with outdated profile information.
                          </AlertDescription>
                        </Alert>
                      )}

                      {/* Show count of relays with errors/not found */}
                      {profilesData && profilesData.filter(p => 'error' in p).length > 0 && (
                        <Alert variant="outline" className="mb-4 border-gray-200 dark:border-gray-800">
                          <AlertCircle className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                          <AlertTitle className="text-gray-800 dark:text-gray-200">Relay Issues</AlertTitle>
                          <AlertDescription className="text-gray-700 dark:text-gray-300">
                            {profilesData.filter(p => 'error' in p).length} relays have issues or no profile found.
                          </AlertDescription>
                        </Alert>
                      )}

                      <div className="rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Relay URL</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Profile</TableHead>
                              <TableHead>Last Updated</TableHead>
                              <TableHead>Issues</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {profilesData.map((profile, index) => {
                              const outdated = isOutdatedProfile(profile);
                              const hasMetadata = !!profile.metadata;
                              const isLatest = profile.timestamp !== undefined && 
                                mostRecentProfile !== undefined && 
                                hasMetadata && 
                                JSON.stringify(profile.metadata) === JSON.stringify(mostRecentProfile);
                              
                              return (
                                <TableRow key={index} className={outdated ? 'bg-destructive/5' : isLatest ? 'bg-green-500/5' : ''}>
                                  <TableCell className="max-w-[200px]">
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center">
                                        {userRelays && userRelays.includes(profile.relayUrl) && (
                                          <span className="mr-1.5 text-primary" title="In user's relay set">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-check-circle">
                                              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                              <polyline points="22 4 12 14.01 9 11.01"/>
                                            </svg>
                                          </span>
                                        )}
                                        <span className="font-medium truncate">
                                          {profile.relayUrl}
                                        </span>
                                      </div>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 ml-2 text-muted-foreground hover:text-primary"
                                        onClick={() => refreshRelayProfile(profile.relayUrl)}
                                        disabled={refreshingRelays[profile.relayUrl] || isLoadingProfiles}
                                      >
                                        <RefreshCw className={`h-3 w-3 ${refreshingRelays[profile.relayUrl] ? 'animate-spin' : ''}`} />
                                      </Button>
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    {/* Status badges with distinct colors:
                                        - Not Checked: secondary (gray)
                                        - Not Found: secondary with custom styling (light gray - not an error)
                                        - Error: destructive (red - actual error)
                                        - Outdated: destructive (red - needs attention)
                                        - Latest: outline with green (most recent)
                                        - OK: secondary (gray - up to date) */}
                                    {'notChecked' in profile ? (
                                      <Badge variant="secondary">Not Checked</Badge>
                                    ) : profile.error ? (
                                      <Badge 
                                        variant={profile.error === 'No profile found' ? 'secondary' : 'destructive'}
                                        className={profile.error === 'No profile found' 
                                          ? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' 
                                          : ''
                                        }
                                      >
                                        {profile.error === 'No profile found' ? 'Not Found' : 'Error'}
                                      </Badge>
                                    ) : (
                                      <>
                                        {outdated && <Badge variant="destructive">Outdated</Badge>}
                                        {isLatest && <Badge variant="outline" className="border-green-500 text-green-500">Latest</Badge>}
                                        {!outdated && !isLatest && <Badge variant="secondary">OK</Badge>}
                                      </>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    {'notChecked' in profile ? (
                                      <Button 
                                        variant="outline" 
                                        size="sm"
                                        className="text-xs"
                                        onClick={() => refreshRelayProfile(profile.relayUrl)}
                                        disabled={refreshingRelays[profile.relayUrl] || isLoadingProfiles}
                                      >
                                        {refreshingRelays[profile.relayUrl] ? 'Checking...' : 'Check Relay'}
                                      </Button>
                                    ) : (
                                      renderProfileContent(profile)
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    {profile.timestamp ? (
                                      <div className="space-y-1">
                                        <div className={isLatest ? "font-bold" : ""}>
                                          {new Date(profile.timestamp * 1000).toLocaleString()}
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                          {isLatest ? (
                                            <span className="text-green-600 dark:text-green-400">Latest</span>
                                          ) : mostRecentTimestamp && (
                                            <span>
                                              {formatDistanceToNow(new Date(profile.timestamp * 1000), { addSuffix: true })}
                                              <span className="ml-1 text-xs text-muted-foreground">
                                                ({Math.round((mostRecentTimestamp - profile.timestamp) / 86400)} days behind)
                                              </span>
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    ) : (
                                      <span>-</span>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    {'notChecked' in profile ? (
                                      <span className="text-muted-foreground text-xs italic">Check relay first</span>
                                    ) : (
                                      renderDifferencesButton(profile, outdated)
                                    )}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                  
                  {/* Simple relay input */}
                  <div className="pt-4 border-t">
                    <label className="text-sm font-medium text-muted-foreground mb-2 block">
                      Add custom relays to check for profiles
                    </label>
                    <div className="flex gap-2 items-center">
                      <Input
                        placeholder="wss://relay.example.com"
                        value={customRelayInput}
                        onChange={(e) => setCustomRelayInput(e.target.value)}
                        className="flex-1 max-w-md"
                        onKeyDown={(e) => e.key === 'Enter' && handleAddRelay()}
                      />
                      <Button onClick={handleAddRelay} size="sm">Add</Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Relay Sets</CardTitle>
                <CardDescription>
                  These are the relays being checked for profiles
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  {relaySets.filter(set => set.label !== 'Custom').map((set, index) => (
                    <div key={index} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h3 className="text-lg font-medium">{set.label} Relays</h3>
                        {set.label === 'User\'s Relays' && isLoadingUserRelays && (
                          <Skeleton className="h-4 w-24" />
                        )}
                      </div>
                      
                      {set.relays.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          {set.label === 'User\'s Relays' 
                            ? isLoadingUserRelays 
                              ? 'Loading...' 
                              : 'No relays found for this user' 
                            : 'No relays added'}
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {set.relays.map((relay, relayIndex) => {
                            const isUserRelay = userRelays && userRelays.includes(relay);
                            return (
                            <Badge 
                              key={relayIndex}
                              variant="secondary"
                              className="flex items-center gap-1"
                            >
                              {isUserRelay && set.label !== 'User\'s Relays' && (
                                <span className="mr-1 text-primary" title="In user's relay set">
                                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-check-circle">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                    <polyline points="22 4 12 14.01 9 11.01"/>
                                </svg>
                                </span>
                              )}
                              {relay}
                            </Badge>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                  
                  {/* Show custom relays if any exist */}
                  {customRelays.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h3 className="text-lg font-medium">Custom Relays</h3>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {customRelays.map((relay, relayIndex) => (
                          <Badge 
                            key={relayIndex}
                            variant="secondary"
                            className="flex items-center gap-1"
                          >
                            {relay}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-4 w-4 text-muted-foreground hover:text-destructive"
                              onClick={() => setCustomRelays(prev => prev.filter(r => r !== relay))}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        <footer className="text-center text-sm text-muted-foreground py-4">
          <p>Vibed with <a href="https://soapbox.pub/mkstack" className="underline" target="_blank" rel="noreferrer">MKStack</a></p>
        </footer>
      </div>
      
      {/* Profile Differences Dialog */}
      <Dialog open={diffDialogOpen} onOpenChange={setDiffDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Profile Differences</DialogTitle>
            <DialogDescription>
              Comparing profiles between relays
            </DialogDescription>
          </DialogHeader>
          
          {currentDiff && mostRecentProfile && currentDiff.profile.metadata && (
            <div className="space-y-4">
              <div className="flex justify-between items-center py-2 border-b">
                <div>
                  <h3 className="font-semibold">Outdated Profile</h3>
                  <p className="text-sm text-muted-foreground">
                    {currentDiff.profile.relayUrl}
                    {currentDiff.profile.timestamp && (
                      <span className="ml-2">
                        ({new Date(currentDiff.profile.timestamp * 1000).toLocaleString()})
                      </span>
                    )}
                  </p>
                </div>
                <ArrowRight className="h-5 w-5" />
                <div>
                  <h3 className="font-semibold">Latest Profile</h3>
                  <p className="text-sm text-muted-foreground">
                    {profilesData?.[0]?.relayUrl}
                    {profilesData?.[0]?.timestamp && (
                      <span className="ml-2">
                        ({new Date(profilesData[0].timestamp! * 1000).toLocaleString()})
                      </span>
                    )}
                  </p>
                </div>
              </div>
              
              <Tabs defaultValue="view">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="view">Visual Diff</TabsTrigger>
                  <TabsTrigger value="code">Code View</TabsTrigger>
                </TabsList>
                
                <TabsContent value="view" className="space-y-4 py-4">
                  {currentDiff.fields.map(field => (
                    <div key={field} className="rounded-lg border overflow-hidden">
                      <div className="bg-muted px-4 py-2 font-medium">
                        {field}
                      </div>
                      <div className="grid grid-cols-2 divide-x">
                        <div className={`p-4 ${currentDiff.profile.metadata?.[field] ? 'bg-red-50 dark:bg-red-950/20' : 'bg-muted'}`}>
                          <p className="text-sm break-words">
                            {currentDiff.profile.metadata?.[field] || <span className="italic text-muted-foreground">(empty)</span>}
                          </p>
                        </div>
                        <div className={`p-4 ${mostRecentProfile?.[field] ? 'bg-green-50 dark:bg-green-950/20' : 'bg-muted'}`}>
                          <p className="text-sm break-words">
                            {mostRecentProfile?.[field] || <span className="italic text-muted-foreground">(empty)</span>}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </TabsContent>
                
                <TabsContent value="code">
                  <div className="grid grid-cols-2 gap-4 pt-4">
                    <div>
                      <h3 className="text-sm font-medium mb-2">Outdated</h3>
                      <pre className="p-4 rounded-md bg-muted overflow-auto max-h-[50vh] text-xs">
                        {JSON.stringify(currentDiff.profile.metadata, null, 2).split('\n').map((line, index) => {
                          // Check if this line contains any of the diffed fields
                          const containsDiff = currentDiff.fields.some(field => line.includes(`"${field}"`));
                          
                          if (containsDiff) {
                            return (
                              <div key={`outdated-line-${index}`} className="bg-red-500/10 -mx-4 px-4">
                                <code>{line}</code>
                              </div>
                            );
                          }
                          return <div key={`outdated-line-${index}`}><code>{line}</code></div>;
                        })}
                      </pre>
                    </div>
                    <div>
                      <h3 className="text-sm font-medium mb-2">Latest</h3>
                      <pre className="p-4 rounded-md bg-muted overflow-auto max-h-[50vh] text-xs">
                        {JSON.stringify(mostRecentProfile, null, 2).split('\n').map((line, index) => {
                          // Check if this line contains any of the diffed fields
                          const containsDiff = currentDiff.fields.some(field => line.includes(`"${field}"`));
                          
                          if (containsDiff) {
                            return (
                              <div key={`latest-line-${index}`} className="bg-green-500/10 -mx-4 px-4">
                                <code>{line}</code>
                              </div>
                            );
                          }
                          return <div key={`latest-line-${index}`}><code>{line}</code></div>;
                        })}
                      </pre>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Index;
