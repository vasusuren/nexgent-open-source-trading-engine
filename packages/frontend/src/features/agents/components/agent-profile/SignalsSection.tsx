'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card';
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from '@/shared/components/ui/form';
import { Slider } from '@/shared/components/ui/slider';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/shared/components/ui/tooltip';
import { HelpCircle, Info, Signal, Filter, TrendingUp } from 'lucide-react';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Input } from '@/shared/components/ui/input';
import { useFormContext } from 'react-hook-form';
import { SignalTypeSelector } from './SignalTypeSelector';
import type { AgentTradingConfigFormValues } from './trading-config-form-schema';

/**
 * Signals Section Component
 *
 * Configures signal filtering settings for the agent:
 * - Minimum signal strength
 * - Allowed signal types
 *
 * Token filter (blacklist/whitelist) and token metrics are in Risk Management tab.
 */
export function SignalsSection() {
  const form = useFormContext<AgentTradingConfigFormValues>();
  const allowedSignalTypes = form.watch('signals.allowedSignalTypes') || [];

  return (
    <div className="space-y-6">
      {/* Signal Strength Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Signal className="h-5 w-5" />
            Signal Strength
          </CardTitle>
          <CardDescription>
            Filter signals by their strength rating
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormField
            control={form.control}
            name="signals.minScore"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FormLabel>Minimum Signal Strength</FormLabel>
                    <TooltipProvider>
                      <Tooltip delayDuration={0}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label="Signal strength help"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <HelpCircle className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-[300px]">
                          <p>
                            Signals are rated 1-5 based on their strength.
                            Higher values mean stronger signals.
                            Only signals meeting or exceeding this threshold will trigger trades.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <span className="text-2xl font-bold tabular-nums">{field.value}</span>
                </div>
                <FormControl>
                  <Slider
                    min={1}
                    max={5}
                    step={1}
                    value={[field.value]}
                    onValueChange={(value) => field.onChange(value[0])}
                    className="py-4"
                  />
                </FormControl>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>1 (Weakest)</span>
                  <span>5 (Strongest)</span>
                </div>
                <FormDescription>
                  Only signals with strength ≥ {field.value} will trigger trades
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      </Card>

      {/* Quality Filters Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <TrendingUp className="h-5 w-5" />
            Quality Filters
          </CardTitle>
          <CardDescription>
            Filter signals by composite score and expected move percentage
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* minSignalScore */}
          <FormField
            control={form.control}
            name="signals.minSignalScore"
            render={({ field }) => {
              const val = field.value ?? 0;
              return (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FormLabel>Min Signal Score</FormLabel>
                      <TooltipProvider>
                        <Tooltip delayDuration={0}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label="Min signal score help"
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <HelpCircle className="h-4 w-4" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[300px]">
                            <p>
                              Composite quality score [0–1] produced by the signal engine.
                              Signals below this threshold are rejected before any portfolio evaluation.
                              Set to 0 to accept all scores.
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <span className="text-2xl font-bold tabular-nums">{val.toFixed(2)}</span>
                  </div>
                  <FormControl>
                    <Slider
                      min={0}
                      max={1}
                      step={0.05}
                      value={[val]}
                      onValueChange={(value) => field.onChange(value[0] === 0 ? undefined : value[0])}
                      className="py-4"
                    />
                  </FormControl>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>0 (no filter)</span>
                    <span>1.0 (max)</span>
                  </div>
                  <FormDescription>
                    {val === 0
                      ? 'All signal scores accepted'
                      : `Only signals with score ≥ ${val.toFixed(2)} will trigger trades`}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              );
            }}
          />

          {/* minExpectedMove */}
          <FormField
            control={form.control}
            name="signals.minExpectedMove"
            render={({ field }) => {
              const val = field.value ?? 0;
              return (
                <FormItem>
                  <div className="flex items-center gap-2">
                    <FormLabel>Min Expected Move (%)</FormLabel>
                    <TooltipProvider>
                      <Tooltip delayDuration={0}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label="Min expected move help"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <HelpCircle className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-[300px]">
                          <p>
                            Minimum expected price move (%) from the magnitude regressor.
                            Signals with a predicted move below this value are rejected.
                            Data shows signals with ≥ 15% expected move outperform significantly.
                            Set to 0 to disable.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      step={0.5}
                      placeholder="0 (disabled)"
                      value={val === 0 ? '' : val}
                      onChange={(e) => {
                        const parsed = parseFloat(e.target.value);
                        field.onChange(isNaN(parsed) || parsed <= 0 ? undefined : parsed);
                      }}
                      className="w-36"
                    />
                  </FormControl>
                  <FormDescription>
                    {val === 0 || val == null
                      ? 'No minimum — all expected moves accepted'
                      : `Only signals predicting ≥ ${val}% move will trigger trades`}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              );
            }}
          />
        </CardContent>
      </Card>

      {/* Signal Types Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Filter className="h-5 w-5" />
            Signal Types
          </CardTitle>
          <CardDescription>
            Choose which signal types can trigger trades
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SignalTypeSelector />

          {allowedSignalTypes.length === 0 && (
            <Alert className="bg-muted/50">
              <Info className="h-4 w-4" />
              <AlertDescription>
                All signal types are accepted. Add specific types above to filter.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
