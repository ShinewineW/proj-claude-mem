import { useState, useEffect, useRef, useCallback } from 'react';
import { Observation, Summary, UserPrompt, StreamEvent } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';

export interface BypassInfo {
  provider: string | null;
  model: string | null;
  state: string | null;
  lastOpencodeCost: string | null;
  lastOpencodeCostAt: string | null;
  opencodeFreeCalls: number;
}

export function useSSE() {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [prompts, setPrompts] = useState<UserPrompt[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const [bypassInfo, setBypassInfo] = useState<BypassInfo | null>(null);
  const [sseSessionStatus, setSseSessionStatus] = useState<Map<string, boolean>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    const connect = () => {
      // Clean up existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(API_ENDPOINTS.STREAM);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('[SSE] Connected');
        setIsConnected(true);
        // Clear any pending reconnect
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
      };

      eventSource.onerror = (error) => {
        console.error('[SSE] Connection error:', error);
        setIsConnected(false);
        eventSource.close();

        // Reconnect after delay
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = undefined; // Clear before reconnecting
          console.log('[SSE] Attempting to reconnect...');
          connect();
        }, TIMING.SSE_RECONNECT_DELAY_MS);
      };

      eventSource.onmessage = (event) => {
        let data: StreamEvent;
        try {
          data = JSON.parse(event.data);
        } catch {
          return; // skip malformed SSE frame
        }

        switch (data.type) {
          case 'initial_load':
            console.log('[SSE] Initial load:', {
              projects: data.projects?.length || 0
            });
            // Reset SSE state on (re)connect to prevent duplicates
            setObservations([]);
            setSummaries([]);
            setPrompts([]);
            setProjects(data.projects || []);
            setSseSessionStatus(new Map());
            break;

          case 'new_observation':
            if (data.observation) {
              const obs = data.observation;
              console.log('[SSE] New observation:', obs.id);
              setObservations(prev => {
                if (prev.some(o => o.id === obs.id)) return prev;
                return [obs, ...prev];
              });
            }
            break;

          case 'new_summary':
            if (data.summary) {
              const summary = data.summary;
              console.log('[SSE] New summary:', summary.id);
              setSummaries(prev => {
                if (prev.some(s => s.id === summary.id)) return prev;
                return [summary, ...prev];
              });
            }
            break;

          case 'new_prompt':
            if (data.prompt) {
              const prompt = data.prompt;
              console.log('[SSE] New prompt:', prompt.id);
              setPrompts(prev => {
                if (prev.some(p => p.id === prompt.id)) return prev;
                return [prompt, ...prev];
              });
            }
            break;

          case 'processing_status':
            if (typeof data.isProcessing === 'boolean') {
              console.log('[SSE] Processing status:', data.isProcessing, 'Queue depth:', data.queueDepth);
              setIsProcessing(data.isProcessing);
              setQueueDepth(data.queueDepth || 0);
            }
            if (data.bypass) setBypassInfo(data.bypass as BypassInfo);
            break;

          case 'session_started':
            if (data.project) {
              console.log('[SSE] Session started:', data.project, data.sessionDbId);
              setSseSessionStatus(prev => {
                const next = new Map(prev);
                next.set(data.project!, true);
                return next;
              });
            }
            break;

          case 'session_completed':
            if (data.project) {
              console.log('[SSE] Session completed:', data.project, data.sessionDbId);
              setSseSessionStatus(prev => {
                const next = new Map(prev);
                next.set(data.project!, false);
                return next;
              });
            }
            break;
        }
      };
    };

    connect();

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  const clearSseSessionStatus = useCallback(() => {
    setSseSessionStatus(new Map());
  }, []);

  return { observations, summaries, prompts, projects, isProcessing, queueDepth, bypassInfo, isConnected, sseSessionStatus, clearSseSessionStatus };
}
