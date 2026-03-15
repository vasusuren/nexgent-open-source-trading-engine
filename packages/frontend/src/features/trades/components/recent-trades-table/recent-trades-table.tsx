'use client';

/**
 * Recent Trades Table Component
 * 
 * Displays a detailed history of completed trades based on agent historical swaps.
 * Includes filtering, sorting, pagination, CSV export, and detail dialog.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table';
import { Button } from '@/shared/components/ui/button';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/shared/components/ui/pagination';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';
import { ExternalLink, Filter, Download, X, Bot, Loader2 } from 'lucide-react';
import { useHistoricalSwaps } from '../../hooks/use-historical-swaps';
import { useExportTrades } from '../../hooks/use-export-trades';
import { useCurrency } from '@/shared/contexts/currency.context';
import { useAgentSelection } from '@/shared/contexts/agent-selection.context';
import { useTradingMode } from '@/shared/contexts/trading-mode.context';
import { useWallet } from '@/shared/contexts/wallet.context';
import { TableSkeleton, ErrorState, LoadingSpinner } from '@/shared/components';
import { formatLocalTime, formatPrice, formatCurrency, abbreviateAddress } from '@/shared/utils/formatting';

// Lazy load dialog component - only shown when user clicks on a trade
const TradeDetailDialog = dynamic(
  () => import('../trade-detail-dialog/trade-detail-dialog').then(mod => ({ default: mod.TradeDetailDialog })),
  { 
    loading: () => <LoadingSpinner size="sm" />,
    ssr: false 
  }
);
import type { AgentHistoricalSwap } from '@/shared/types/api.types';
import type { TradeSortOption } from '../../types/trade.types';

export function RecentTradesTable() {
  const { currencyPreference, solPrice } = useCurrency();
  const { selectedAgentId } = useAgentSelection();
  const { tradingMode } = useTradingMode();
  const { wallets } = useWallet();

  // Get wallet for current trading mode
  const walletForMode = wallets.find((w) => w.walletType === tradingMode);
  const walletAddress = walletForMode?.walletAddress;

  const [showFilters, setShowFilters] = useState(false);
  const [contractAddressFilter, setContractAddressFilter] = useState('');
  const [sortBy, setSortBy] = useState<TradeSortOption>('most_recent');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const [selectedSwap, setSelectedSwap] = useState<AgentHistoricalSwap | null>(null);
  const [isTradeDetailsDialogOpen, setIsTradeDetailsDialogOpen] = useState(false);

  // Reset to first page when wallet/trading mode changes
  useEffect(() => {
    setCurrentPage(1);
  }, [walletAddress]);

  // Fetch historical swaps (filtered by current trading mode wallet if available)
  // walletAddress may be undefined if the agent has no wallet for the current mode —
  // in that case we still fetch all trades for the agent (no wallet filter applied).
  const { data: swaps = [], isLoading, isError, error, refetch } = useHistoricalSwaps({
    agentId: selectedAgentId || '',
    walletAddress, // Filter by current trading mode wallet (omitted when undefined)
    limit: 1000, // Fetch enough to handle client-side filtering/sorting
  }, { enabled: !!selectedAgentId }); // Only requires agentId

  // Export hook
  const exportTrades = useExportTrades();

  // Filtering and sorting logic
  const filteredSwaps = useMemo(() => {
    // Create a copy to avoid mutating the original array
    let filtered = [...swaps];

    // Filter by contract address or token symbol
    if (contractAddressFilter) {
      filtered = filtered.filter((swap) =>
        swap.tokenSymbol.toLowerCase().includes(contractAddressFilter.toLowerCase()) ||
        swap.tokenAddress.toLowerCase().includes(contractAddressFilter.toLowerCase())
      );
    }

    // Sorting logic - create a new sorted array
    filtered = [...filtered].sort((a, b) => {
      if (sortBy === 'most_recent') {
        return new Date(b.saleTime).getTime() - new Date(a.saleTime).getTime();
      } else if (sortBy === 'highest_profit') {
        return parseFloat(b.profitLossUsd) - parseFloat(a.profitLossUsd);
      } else if (sortBy === 'biggest_loss') {
        return parseFloat(a.profitLossUsd) - parseFloat(b.profitLossUsd);
      }
      return 0;
    });

    return filtered;
  }, [swaps, contractAddressFilter, sortBy, walletAddress]);

  // Pagination logic
  const totalPages = Math.ceil(filteredSwaps.length / itemsPerPage);
  const displayedSwaps = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredSwaps.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredSwaps, currentPage, itemsPerPage]);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [contractAddressFilter, sortBy]);

  const handleDownloadCSV = useCallback(() => {
    if (!selectedAgentId) return;

    // Build export query from current filters
    // Note: sortBy is client-side only, so we don't include it in the export query
    // This now exports ALL records matching the filters (not just the 1000 limit)
    const exportQuery: any = {
      agentId: selectedAgentId,
      // Filter by current trading mode wallet
      walletAddress,
      // Pass currency preference and SOL price for proper price formatting
      currency: currencyPreference,
      solPrice: solPrice.toString(),
    };

    // Add token filter if present (could be address or symbol)
    // Solana addresses are base58 encoded and typically 32-44 characters
    // Token symbols are usually much shorter (1-10 characters)
    if (contractAddressFilter) {
      const filterValue = contractAddressFilter.trim();
      // If it looks like an address (long string, typically 32+ chars), use tokenAddress
      // Otherwise, use tokenSymbol
      if (filterValue.length >= 32) {
        exportQuery.tokenAddress = filterValue;
      } else {
        exportQuery.tokenSymbol = filterValue;
      }
    }

    exportTrades.mutate(exportQuery);
  }, [selectedAgentId, walletAddress, contractAddressFilter, exportTrades, currencyPreference, solPrice]);

  const handleSwapClick = useCallback((swap: AgentHistoricalSwap) => {
    setSelectedSwap(swap);
    setIsTradeDetailsDialogOpen(true);
  }, []);

  if (!selectedAgentId) {
    return (
      <Card className="relative transition-all duration-300">
        <CardHeader>
          <CardTitle>Recent Agent Trades</CardTitle>
          <CardDescription>
            View a detailed history of trades completed by your AI agent, including entry and exit points, timestamps, and outcomes. Track performance and refine your strategy with real-time insights.
          </CardDescription>
        </CardHeader>
        <CardContent className="relative p-2 md:p-4">
          <div className="text-center py-12">
            <Bot className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Agent Selected</h3>
            <p className="text-muted-foreground mb-4">
              Please select an agent from the sidebar to view its trade history.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="relative transition-all duration-300">
      <CardHeader>
        <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              Recent Agent Trades
            </CardTitle>
            <CardDescription>
              View a detailed history of trades completed by your AI agent, including entry and exit points, timestamps, and outcomes. Track performance and refine your strategy with real-time insights.
            </CardDescription>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-2"
            >
              <Filter className="h-4 w-4" />
              Filters
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadCSV}
              className="flex items-center gap-2"
              disabled={!selectedAgentId || exportTrades.isPending}
            >
              {exportTrades.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  Download CSV
                </>
              )}
            </Button>
          </div>
        </div>

        {showFilters && (
          <div className="mt-4 p-4 border rounded-lg bg-muted/30 space-y-4">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1 space-y-2">
                <Label htmlFor="contract-filter">Contract Address / Token</Label>
                <div className="relative">
                  <Input
                    id="contract-filter"
                    placeholder="Filter by token address or symbol..."
                    value={contractAddressFilter}
                    onChange={(e) => setContractAddressFilter(e.target.value)}
                  />
                  {contractAddressFilter && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1 h-6 w-6"
                      onClick={() => setContractAddressFilter('')}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex-1 space-y-2">
                <Label htmlFor="sort-by">Sort By</Label>
                <Select value={sortBy} onValueChange={(value) => setSortBy(value as typeof sortBy)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Sort by..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="most_recent">Most Recent</SelectItem>
                    <SelectItem value="highest_profit">Highest Profit</SelectItem>
                    <SelectItem value="biggest_loss">Biggest Loss</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {(contractAddressFilter || sortBy !== 'most_recent') && (
              <div className="flex items-center justify-between pt-2 border-t">
                <div className="text-sm text-muted-foreground">
                  Active filters: {[
                    contractAddressFilter && 'Contract Address',
                    sortBy !== 'most_recent' && 'Custom Sort',
                  ].filter(Boolean).join(', ')}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setContractAddressFilter('');
                    setSortBy('most_recent');
                  }}
                  className="text-sm"
                >
                  Clear All
                </Button>
              </div>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="relative p-2 md:p-4">
        <div className="rounded-md border relative overflow-x-auto w-full">
          <Table className="min-w-[200px] text-sm">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Token</TableHead>
                <TableHead className="hidden md:table-cell">Amount</TableHead>
                <TableHead className="hidden lg:table-cell">Average Purchase Price ({currencyPreference})</TableHead>
                <TableHead className="hidden lg:table-cell">Sale Price ({currencyPreference})</TableHead>
                <TableHead>Profit / Loss ({currencyPreference})</TableHead>
                <TableHead className="hidden md:table-cell">Change (%)</TableHead>
                <TableHead>Close Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="p-0">
                    <TableSkeleton rows={5} columns={8} showHeader={false} />
                  </TableCell>
                </TableRow>
              ) : isError ? (
                <TableRow>
                  <TableCell colSpan={8} className="p-8">
                    <ErrorState
                      error={error}
                      onRetry={() => refetch()}
                      title="Failed to load trades"
                    />
                  </TableCell>
                </TableRow>
              ) : displayedSwaps.length > 0 ? (
                displayedSwaps.map((swap) => {
                  const purchasePrice = currencyPreference === 'USD'
                    ? parseFloat(swap.purchasePrice) * (solPrice || 100)
                    : parseFloat(swap.purchasePrice);
                  const salePrice = currencyPreference === 'USD'
                    ? parseFloat(swap.salePrice) * (solPrice || 100)
                    : parseFloat(swap.salePrice);
                  const profitLoss = currencyPreference === 'USD'
                    ? parseFloat(swap.profitLossUsd)
                    : parseFloat(swap.profitLossSol);
                  const changePercent = parseFloat(swap.changePercent);

                  return (
                    <TableRow
                      key={swap.id}
                      className="cursor-pointer hover:bg-accent/40"
                      onClick={() => handleSwapClick(swap)}
                    >
                      <TableCell>{formatLocalTime(swap.saleTime)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div>
                            <div className="font-medium">{swap.tokenSymbol}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {abbreviateAddress(swap.tokenAddress)}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5"
                            onClick={(e) => {
                              e.stopPropagation();
                              window.open(`https://dexscreener.com/solana/${swap.tokenAddress}`, '_blank');
                            }}
                          >
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {parseFloat(swap.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {formatPrice(purchasePrice, currencyPreference === 'USD')}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {formatPrice(salePrice, currencyPreference === 'USD')}
                      </TableCell>
                      <TableCell className={`font-mono ${profitLoss >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {formatCurrency(profitLoss, currencyPreference, solPrice, { showSign: true })}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className={changePercent >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {(changePercent >= 0 ? '+' : '') + changePercent.toFixed(2)}%
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {swap.closeReason === 'stale_trade'
                            ? 'Stale Trade'
                            : swap.closeReason === 'stop_loss'
                            ? 'Stop Loss'
                            : swap.closeReason === 'manual'
                            ? 'Manual'
                            : swap.closeReason === 'signal_replace'
                            ? 'Replaced'
                            : swap.closeReason === 'take_profit'
                            ? 'Take Profit'
                            : swap.closeReason ?? 'Unknown'}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    No completed trades yet. Your agent will display its trading history here.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {totalPages > 1 && (
          <div className="flex justify-center mt-4">
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setCurrentPage((p) => Math.max(1, p - 1));
                    }}
                    className={currentPage === 1 ? 'pointer-events-none opacity-50' : ''}
                  />
                </PaginationItem>
                
                {/* Always show page 1 */}
                <PaginationItem>
                  <PaginationLink
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setCurrentPage(1);
                    }}
                    isActive={currentPage === 1}
                  >
                    1
                  </PaginationLink>
                </PaginationItem>
                
                {/* Show ellipsis if current page is far from start */}
                {currentPage > 3 && (
                  <PaginationItem>
                    <PaginationEllipsis />
                  </PaginationItem>
                )}
                
                {/* Show previous page if not page 1 or 2 */}
                {currentPage > 2 && currentPage !== totalPages && (
                  <PaginationItem>
                    <PaginationLink
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setCurrentPage(currentPage - 1);
                      }}
                    >
                      {currentPage - 1}
                    </PaginationLink>
                  </PaginationItem>
                )}
                
                {/* Show current page if it's not page 1 or last page */}
                {currentPage !== 1 && currentPage !== totalPages && (
                  <PaginationItem>
                    <PaginationLink
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setCurrentPage(currentPage);
                      }}
                      isActive={true}
                    >
                      {currentPage}
                    </PaginationLink>
                  </PaginationItem>
                )}
                
                {/* Show next page if not last page or second to last */}
                {currentPage < totalPages - 1 && (
                  <PaginationItem>
                    <PaginationLink
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setCurrentPage(currentPage + 1);
                      }}
                    >
                      {currentPage + 1}
                    </PaginationLink>
                  </PaginationItem>
                )}
                
                {/* Show ellipsis if current page is far from end */}
                {currentPage < totalPages - 2 && (
                  <PaginationItem>
                    <PaginationEllipsis />
                  </PaginationItem>
                )}
                
                {/* Always show last page (if more than 1 page) */}
                {totalPages > 1 && (
                  <PaginationItem>
                    <PaginationLink
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setCurrentPage(totalPages);
                      }}
                      isActive={currentPage === totalPages}
                    >
                      {totalPages}
                    </PaginationLink>
                  </PaginationItem>
                )}
                
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setCurrentPage((p) => Math.min(totalPages, p + 1));
                    }}
                    className={currentPage === totalPages ? 'pointer-events-none opacity-50' : ''}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        )}
      </CardContent>

      {/* Trade Details Dialog */}
      <TradeDetailDialog
        swap={selectedSwap}
        isOpen={isTradeDetailsDialogOpen}
        onOpenChange={setIsTradeDetailsDialogOpen}
        currencyPreference={currencyPreference}
        solPrice={solPrice}
      />
    </Card>
  );
}

