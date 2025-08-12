import { useSeoMeta } from '@unhead/react';
import { useState, useCallback, useEffect } from 'react';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { nip19 } from 'nostr-tools';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Info, AlertCircle, X } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { LoginArea } from '@/components/auth/LoginArea';
import { useToast } from '@/hooks/useToast';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Add TypeScript interface for window.nostr
declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (event: any) => Promise<any>;
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

interface ProfileData {
  relayUrl: string;
  event?: {
    pubkey: string;
    content: string;
    created_at: number;
    tags: string[][];
    id: string;
    sig: string;
    kind: number;
  };
  error?: string;
  metadata?: ProfileMetadata;
  timestamp?: number;
}

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
    queryKey: ['profiles', pubkey, relaySets],
    queryFn: async ({ signal }) => {
      if (!pubkey) return [];
      
      // Get all unique relays from all sets
      const allRelays = [...new Set(relaySets.flatMap(set => set.relays))];
      
      if (allRelays.length === 0) {
        return [];
      }
      
      const profilePromises = allRelays.map(async (relayUrl) => {
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
            } catch (_) {
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
      
      const results = await Promise.all(profilePromises);
      
      // Sort by timestamp, most recent first
      return results.sort((a, b) => {
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return b.timestamp - a.timestamp;
      });
    },
    enabled: !!pubkey && relaySets.some(set => set.relays.length > 0),
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
        } catch (_) {
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

  // Find the most recent profile
  const mostRecentProfile = profilesData?.find(p => p.timestamp)?.metadata;

  // Determine if a profile is outdated compared to the most recent one
  const isOutdatedProfile = (profile: ProfileData) => {
    if (!mostRecentProfile || !profile.metadata) return false;
    
    // Check if any field is different from the most recent profile
    const fields = ['name', 'display_name', 'picture', 'banner', 'about', 'website', 'nip05', 'lud06', 'lud16'];
    
    return fields.some(field => {
      return mostRecentProfile[field] !== profile.metadata[field] && 
        (mostRecentProfile[field] || profile.metadata[field]); // Ensure at least one is non-empty
    });
  };

  // Get all relays with outdated profiles
  const outdatedRelays = profilesData?.filter(profile => isOutdatedProfile(profile)) || [];

  // Render the profile content
  const renderProfileContent = (profile: ProfileData) => {
    if (!profile.metadata) {
      return profile.error ? (
        <span className="text-destructive">{profile.error}</span>
      ) : (
        <span className="text-muted-foreground">No data</span>
      );
    }
    
    const metadata = profile.metadata;
    
    return (
      <div className="flex items-center gap-2">
        {metadata.picture && (
          <img 
            src={metadata.picture} 
            alt="Profile" 
            className="w-8 h-8 rounded-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).src = 'https://via.placeholder.com/150';
            }}
          />
        )}
        <span className="font-medium">
          {metadata.display_name || metadata.name || 'Unnamed'}
        </span>
      </div>
    );
  };
  
  // Render the differences button
  const renderDifferencesButton = (profile: ProfileData, outdated: boolean) => {
    if (!outdated || !mostRecentProfile || !profile.metadata) {
      return null;
    }
    
    const metadata = profile.metadata;
    
    return (
      <Button 
        variant="ghost" 
        size="sm"
        className="text-xs"
        onClick={() => {
          // Create a list of differences
          const differences = ['name', 'display_name', 'picture', 'banner', 'about', 'website', 'nip05', 'lud06', 'lud16']
            .filter(field => mostRecentProfile[field] !== metadata[field])
            .map(field => `${field}: "${metadata[field] || '(empty)'}" vs "${mostRecentProfile[field] || '(empty)'}"`)
            .join('\n');
          
          toast({
            title: 'Profile Differences',
            description: (
              <pre className="mt-2 w-[340px] rounded-md bg-slate-950 p-4 overflow-x-auto">
                <code className="text-white">{differences}</code>
              </pre>
            ),
          });
        }}
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
              <CardHeader>
                <CardTitle>Custom Relays</CardTitle>
                <CardDescription>
                  Add additional relays to check for profiles
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2 mb-4">
                  <Input
                    placeholder="wss://relay.example.com"
                    value={customRelayInput}
                    onChange={(e) => setCustomRelayInput(e.target.value)}
                    className="flex-1"
                  />
                  <Button onClick={handleAddRelay}>Add</Button>
                </div>
                
                <div className="mt-2 flex flex-wrap gap-2">
                  {customRelays.map((relay, index) => (
                    <Badge 
                      key={index}
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
              </CardContent>
            </Card>

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
                  <Button onClick={() => refetchProfiles()} variant="outline" size="sm">
                    Refresh
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
                                  <TableCell className="font-medium truncate max-w-[200px]">
                                    {profile.relayUrl}
                                  </TableCell>
                                  <TableCell>
                                    {profile.error ? (
                                      <Badge variant="destructive">Error</Badge>
                                    ) : (
                                      <>
                                        {outdated && <Badge variant="destructive">Outdated</Badge>}
                                        {isLatest && <Badge variant="outline" className="border-green-500 text-green-500">Latest</Badge>}
                                        {!outdated && !isLatest && <Badge variant="secondary">OK</Badge>}
                                      </>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    {renderProfileContent(profile)}
                                  </TableCell>
                                  <TableCell>
                                    {profile.timestamp ? (
                                      <span className="text-sm text-muted-foreground">
                                        {new Date(profile.timestamp * 1000).toLocaleString()}
                                      </span>
                                    ) : (
                                      <span>-</span>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    {renderDifferencesButton(profile, outdated)}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
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
                  {relaySets.map((set, index) => (
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
                          {set.relays.map((relay, relayIndex) => (
                            <Badge 
                              key={relayIndex}
                              variant="secondary"
                              className="flex items-center gap-1"
                            >
                              {relay}
                              {set.label === 'Custom' && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-4 w-4 text-muted-foreground hover:text-destructive"
                                  onClick={() => setCustomRelays(prev => prev.filter(r => r !== relay))}
                                >
                                  <X className="h-3 w-3" />
                                </Button>
                              )}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        <footer className="text-center text-sm text-muted-foreground py-4">
          <p>Vibed with <a href="https://soapbox.pub/mkstack" className="underline" target="_blank" rel="noreferrer">MKStack</a></p>
        </footer>
      </div>
    </div>
  );
};

export default Index;
