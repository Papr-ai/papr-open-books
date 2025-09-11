'use client';

import { useChat } from '@ai-sdk/react';
import type { DataUIPart, UIMessage } from 'ai';
import { useEffect, useRef, useState } from 'react';
import { artifactDefinitions, type ArtifactKind } from '../artifact/artifact';
import type { Suggestion } from '@/lib/db/schema';
import { useArtifact } from '@/hooks/use-artifact';
import { useThinkingState } from '@/lib/thinking-state';
import { useBreadcrumb } from '@/components/layout/breadcrumb-context';

export type DataStreamDelta = {
  type:
    | 'text-delta'
    | 'code-delta'
    | 'sheet-delta'
    | 'image-delta'
    | 'image-generated'
    | 'image-edited'
    | 'images-merged'
    | 'structured-book-image-start'
    | 'structured-book-image-progress'
    | 'structured-book-image-result'
    | 'structured-book-image-complete'
    | 'structured-book-image-approval'
    | 'single-book-image-start'
    | 'single-book-image-complete'
    | 'single-book-image-auto-inserted'
    | 'single-book-image-auto-insert-failed'
    | 'single-book-image-auto-insert-error'
    | 'title'
    | 'id'
    | 'suggestion'
    | 'clear'
    | 'finish'
    | 'kind'
    | 'status'
    | 'tool-call'
    | 'tool-result'
    | 'progress'
    | 'github-staged-files'
    | 'github-selection'
    | 'repository-approval-request'
    | 'repository-created'
    | 'project-creation-started';
  content: string | Suggestion | Record<string, any>;
  language?: string;
  toolCall?: {
    id: string;
    name: string;
  };
  toolResult?: {
    id: string;
    result: any;
  };
  tool_calls?: Array<{
    id: string;
    function: {
      name: string;
    };
  }>;
};

export function DataStreamHandler({ id }: { id: string }) {
  const [dataStream, setDataStream] = useState<DataUIPart<any>[]>([]);
  
  const { messages, status } = useChat({ 
    id,
    onData: (dataPart: DataUIPart<any>) => {
      // Handle incoming data parts from the stream
      setDataStream(prev => [...prev, dataPart]);
    }
  });
  
  // Breadcrumb title updater: update when title delta arrives
  const { setTitle } = useBreadcrumb();
  const { artifact, setArtifact, setMetadata } = useArtifact();
  const lastProcessedIndex = useRef(-1);
  const { setThinkingState } = useThinkingState();
  
  // Get the artifact definition to access its onStreamPart handler
  const artifactDefinition = artifactDefinitions.find(
    (definition) => definition.kind === artifact.kind,
  );
  
  // Handle when chat is stopped - ensure artifact status is updated
  useEffect(() => {
    if (status !== 'streaming' && artifact.status === 'streaming') {
      console.log('[DATA STREAM] Chat stopped, updating artifact status to idle');
      setArtifact((draftArtifact) => ({
        ...draftArtifact,
        status: 'idle',
      }));
    }
  }, [status, artifact.status, setArtifact]);
  
  useEffect(() => {
    if (!dataStream?.length) return;

    const newDeltas = dataStream.slice(lastProcessedIndex.current + 1);
    lastProcessedIndex.current = dataStream.length - 1;

    // Log all new data parts
    console.log(
      '[DATA STREAM] New data parts:',
      newDeltas.map((dataPart: DataUIPart<any>) => ({
        type: dataPart.type,
        id: dataPart.id,
        data: dataPart.data,
      })),
    );

    // Handle errors first - look for data-error type
    const errorDelta = newDeltas.find(
      (dataPart: DataUIPart<any>) => dataPart.type === 'data-error',
    );

    if (errorDelta) {
      console.error('[DATA STREAM] Error data part received:', errorDelta);
      setArtifact((draftArtifact) => ({
        ...draftArtifact,
        status: 'idle',
        isVisible: true,
      }));
      
      setThinkingState('Thinking...', 'error_detected');
      return;
    }

    // Process each data part in sequence
    newDeltas.forEach((dataPart: DataUIPart<any>) => {
      if (!dataPart || typeof dataPart !== 'object') return;

      // Handle different data types based on the dataPart.type
      // In AI SDK 5.0, types are like 'data-artifact', 'data-title', etc.
      const dataType = dataPart.type.startsWith('data-') ? dataPart.type.slice(5) : dataPart.type;

      // Call the artifact's onStreamPart handler for all events, including custom ones
      if (artifactDefinition?.onStreamPart) {
        try {
          // Convert DataUIPart to DataStreamDelta for backward compatibility
          const compatibilityDelta: DataStreamDelta = {
            type: dataType as any,
            content: dataPart.data,
            // Add other properties if they exist in the dataPart
            ...(dataPart.id && { toolCall: { id: dataPart.id, name: dataType } }),
          };
          
          artifactDefinition.onStreamPart({
            streamPart: compatibilityDelta,
            setArtifact,
            setMetadata: (draft: Record<string, any>) => ({ 
              ...draft, 
              metadata: { 
                ...draft.metadata, 
                ...(typeof dataPart.data === 'object' && dataPart.data !== null ? dataPart.data : {}) 
              } 
            }),
          });
        } catch (error) {
          console.error('[DATA STREAM] Error calling artifact onStreamPart handler:', error);
        }
      }
      
      switch (dataType) {
        case 'id':
          setArtifact((draftArtifact) => ({
            ...draftArtifact,
            documentId: dataPart.data as string,
            status: 'streaming',
          }));
          break;

        case 'title':
          // Update artifact and breadcrumb title
          setArtifact((draftArtifact) => ({
            ...draftArtifact,
            title: dataPart.data as string,
            status: 'streaming',
          }));
          setTitle(dataPart.data as string);
          break;

        case 'kind':
          setArtifact((draftArtifact) => ({
            ...draftArtifact,
            kind: dataPart.data as ArtifactKind,
            status: 'streaming',
          }));
          break;

        case 'clear':
          setArtifact((draftArtifact) => ({
            ...draftArtifact,
            content: '',
            status: 'streaming',
          }));
          break;

        case 'status':
          setArtifact((draftArtifact) => ({
            ...draftArtifact,
            status: dataPart.data as 'streaming' | 'idle',
          }));
          break;

        case 'text-delta':
          setArtifact((draftArtifact) => ({
            ...draftArtifact,
            content: draftArtifact.content + (dataPart.data as string),
            status: 'streaming',
          }));
          break;

        case 'finish':
          // Don't read from artifact here, as that creates a dependency
          console.log('[DATA STREAM] Finishing document generation');
          setArtifact((draftArtifact) => ({
            ...draftArtifact,
            status: 'idle',
          }));
          
          // Don't reset thinking state immediately on finish to avoid UI flicker
          // The thinking state will be properly updated when content is ready
          break;

        case 'progress':
          // Handle progress updates from tools (e.g., GitHub file creation)
          const progressData = dataPart.data as any;
          console.log('[DATA STREAM] Progress update:', progressData);
          
          // Update thinking state with progress message
          if (progressData.message) {
            console.log('[DATA STREAM] Setting thinking state to:', progressData.message);
            setThinkingState(progressData.message, 'github-progress');
          }
          
          // Handle specific progress actions
          if (progressData.action === 'project-init') {
            console.log('[DATA STREAM] Project initialization started');
            setThinkingState(`🔄 ${progressData.message}`, 'github-project-init');
          } else if (progressData.action === 'fetching-repositories') {
            console.log('[DATA STREAM] Fetching repositories started');
            setThinkingState(`🔄 ${progressData.message}`, 'github-fetching');
          } else if (progressData.action === 'repositories-loaded') {
            console.log('[DATA STREAM] Repositories loaded');
            setThinkingState(`✅ ${progressData.message}`, 'github-loaded');
          } else if (progressData.action === 'repositories-error') {
            console.log('[DATA STREAM] Repository loading error');
            setThinkingState(`❌ ${progressData.message}`, 'github-error');
          } else if (progressData.action === 'staging-project') {
            console.log('[DATA STREAM] Project staging started');
            const detailsText = progressData.details ? ` (${progressData.details.totalFiles} files)` : '';
            setThinkingState(`🔄 ${progressData.message}${detailsText}`, 'github-staging');
            
            // Create a temporary content update showing project staging
            setArtifact((draftArtifact) => ({
              ...draftArtifact,
              content: JSON.stringify({
                action: 'staging-project',
                message: progressData.message,
                repository: progressData.repository,
                projectName: progressData.projectName,
                projectType: progressData.projectType,
                details: progressData.details,
                status: 'in-progress'
              }, null, 2),
              status: 'streaming',
              isVisible: true,
            }));
          } else if (progressData.action === 'staging-file') {
            console.log('[DATA STREAM] File staging in progress');
            const progressText = progressData.progress ? ` (${progressData.progress})` : '';
            setThinkingState(`📁 ${progressData.message}${progressText}`, 'github-file-staging');
            
            // Create a temporary content update showing file being staged
            setArtifact((draftArtifact) => ({
              ...draftArtifact,
              content: JSON.stringify({
                action: 'staging-file',
                message: progressData.message,
                fileName: progressData.fileName,
                fileContent: progressData.fileContent,
                progress: progressData.progress,
                status: 'in-progress'
              }, null, 2),
              status: 'streaming',
              isVisible: true,
            }));
          } else if (progressData.action === 'project-completed') {
            // When project is completed, auto-open GitHub file explorer
            console.log('[DATA STREAM] Project completed, should open GitHub explorer');
            setThinkingState(`✅ ${progressData.message}`, 'github-completed');
            
            // Create a GitHub file explorer artifact
            const explorerTitle = `GitHub File Explorer: Repository ${progressData.repository}`;
            
            setArtifact((draftArtifact) => ({
              ...draftArtifact,
              kind: 'text',
              title: explorerTitle,
              status: 'idle',
              isVisible: true,
            }));
          } else if (progressData.action === 'project-staged') {
            // When project is staged, auto-open GitHub file explorer
            console.log('[DATA STREAM] Project staged, should open GitHub explorer');
            const projectDetails = progressData.projectDetails ? ` - ${progressData.projectDetails.type} project` : '';
            setThinkingState(`✅ ${progressData.message}${projectDetails}`, 'github-staged');
            
            // Create a GitHub file explorer artifact
            const explorerTitle = `GitHub File Explorer: Repository ${progressData.repository}`;
            
            setArtifact((draftArtifact) => ({
              ...draftArtifact,
              kind: 'text',
              title: explorerTitle,
              status: 'idle',
              isVisible: true,
            }));
          }
          break;

        case 'project-creation-started':
          // Handle project creation started - show progress card
          const projectStartData = dataPart.data as any;
          console.log('[DATA STREAM] Project creation started:', projectStartData);
          
          // Update thinking state
          if (projectStartData.message) {
            setThinkingState(projectStartData.message, 'project-creation-started');
          }
          
          // Create project creation progress card
          setArtifact((draftArtifact) => ({
            ...draftArtifact,
            kind: 'text',
            title: `Creating Project: ${projectStartData.project?.name || 'New Project'}`,
            content: JSON.stringify({
              type: 'project-creation-started',
              project: projectStartData.project,
              message: projectStartData.message,
              status: 'creating',
            }, null, 2),
            status: 'streaming',
            isVisible: true,
          }));
          break;

        case 'github-selection':
          // Handle GitHub repository/file selection to open file explorer
          const selectionData = dataPart.data as any;
          console.log('[DATA STREAM] GitHub selection received:', selectionData);
          
          if (selectionData.repository) {
            // Update thinking state with file summary
            const summary = selectionData.summary;
            const summaryText = summary ? 
              `Found ${summary.total} files (${summary.githubFiles} from GitHub, ${summary.stagedOnlyFiles} staged)` :
              `Opening GitHub file explorer for ${selectionData.repository.owner}/${selectionData.repository.name}`;
            
            setThinkingState(summaryText, 'github-selection');
            
            // Create GitHub file explorer artifact with file data
            const explorerTitle = `GitHub File Explorer: ${selectionData.repository.owner}/${selectionData.repository.name}`;
            
            setArtifact((draftArtifact) => ({
              ...draftArtifact,
              kind: 'text',
              title: explorerTitle,
              status: 'idle',
              isVisible: true,
              content: JSON.stringify({
                repository: selectionData.repository,
                files: selectionData.files || [],
                stagedFiles: selectionData.stagedFiles || [],
                summary: selectionData.summary || {
                  total: 0,
                  githubFiles: 0,
                  stagedFiles: 0,
                  stagedOnlyFiles: 0,
                },
              }, null, 2),
            }));
          }
          break;

        case 'github-staged-files':
          // Handle GitHub staged files updates
          const stagedFilesData = dataPart.data as any;
          console.log('[DATA STREAM] GitHub staged files received:', stagedFilesData);
          
          // Update thinking state
          if (stagedFilesData.files) {
            setThinkingState(`Updated ${stagedFilesData.files.length} staged files`, 'github-staged-files');
          }
          break;

        case 'suggestion':
          // Handle suggestions from the AI
          const suggestionData = dataPart.data as Suggestion;
          console.log('[DATA STREAM] Suggestion received:', suggestionData);
          break;

        case 'tool-call':
          // Handle tool call events - show inline feedback when tool starts
          const toolCallData = dataPart.data as any;
          console.log('[DATA STREAM] Tool call received:', toolCallData);
          
          // Add safety checks to prevent undefined errors
          if (toolCallData && typeof toolCallData === 'object') {
            // The tool call data could be structured in two ways:
            // 1. Legacy format: { name: 'createFile', args: {...} }
            // 2. New format: { content: { name: 'createFile', args: {...} } }
            
            const name = toolCallData.content?.name || toolCallData.name;
            const args = toolCallData.content?.args || toolCallData.args;
            const message = toolCallData.content?.message || toolCallData.message;
            const status = toolCallData.content?.status || toolCallData.status;
            
            // Handle createFile tool calls
            if (name === 'createFile' && args) {
              console.log('[DATA STREAM] Creating file via tool call:', args);
              
              // Access the window codeArtifactApi if available
              if (typeof window !== 'undefined' && (window as any).codeArtifactApi) {
                const api = (window as any).codeArtifactApi;
                const { path, content, language } = args;
                
                if (path && content) {
                  // Create or update file using the API
                  api.createOrUpdateFile(path, content, language);
                  console.log(`[DATA STREAM] Created/updated file: ${path}`);
                  
                  // Update thinking state with success message
                  setThinkingState(`Created file: ${path}`, 'tool-result-success');
                }
              }
            }
            
            // Update thinking state with tool call message if it exists
            if (typeof message === 'string') {
              setThinkingState(message, 'tool-call');
            }
            
            // Show the tool call is in progress in the artifact
            if (status === 'started') {
              setArtifact((draftArtifact) => ({
                ...draftArtifact,
                isVisible: true,
              }));
            }
          }
          break;

        case 'tool-result':
          // Handle tool result events - show inline feedback when tool completes
          const toolResultData = dataPart.data as any;
          console.log('[DATA STREAM] Tool result received:', toolResultData);
          
          // Update thinking state with tool result message
          if (toolResultData.message) {
            if (toolResultData.status === 'completed') {
              setThinkingState(toolResultData.message, 'tool-result-success');
            } else if (toolResultData.status === 'error') {
              setThinkingState(toolResultData.message, 'tool-result-error');
            }
          }
          break;

        case 'repository-approval-request':
          // Handle repository approval requests - show approval card
          const approvalData = dataPart.data as any;
          console.log('[DATA STREAM] Repository approval request received:', approvalData);
          
          // Update thinking state
          if (approvalData.message) {
            setThinkingState(approvalData.message, 'repository-approval-request');
          }
          
          // Create approval card artifact
          setArtifact((draftArtifact) => ({
            ...draftArtifact,
            kind: 'text',
            title: `Repository Approval Required`,
            content: `**Repository Creation Request**

I need your approval to create a new GitHub repository:

**Repository Name:** ${approvalData.repositoryName}
**Description:** ${approvalData.repositoryDescription}

This repository will be created in your GitHub account and will be ready for project files.

Please reply with **Approve** to proceed with creation, or **Stop** to cancel.`,
            status: 'idle',
            isVisible: true,
          }));
          break;

        case 'image-generated':
          // Handle image generation events
          const imageGeneratedData = dataPart.data as any;
          console.log('[DATA STREAM] Image generated:', imageGeneratedData);
          
          // Update thinking state with success message
          if (imageGeneratedData.content) {
            setThinkingState('✅ Image generated successfully', 'tool-result-success');
          }
          break;

        case 'image-edited':
          // Handle image editing events
          const imageEditedData = dataPart.data as any;
          console.log('[DATA STREAM] Image edited:', imageEditedData);
          
          // Update thinking state with success message
          if (imageEditedData.content) {
            setThinkingState('✅ Image edited successfully', 'tool-result-success');
          }
          break;

        case 'images-merged':
          // Handle image merging events
          const imagesMergedData = dataPart.data as any;
          console.log('[DATA STREAM] Images merged:', imagesMergedData);
          
          // Update thinking state with success message
          if (imagesMergedData.content) {
            setThinkingState('✅ Images merged successfully', 'tool-result-success');
          }
          break;

        case 'structured-book-image-start':
          // Handle structured book image creation start
          const startData = dataPart.data as any;
          console.log('[DATA STREAM] Structured book image creation started:', startData);
          
          setThinkingState(`🎨 Starting systematic image creation for "${startData.content?.bookTitle}"`, 'tool-result-info');
          break;

        case 'single-book-image-start':
          // Handle single book image creation start
          const singleStartData = dataPart.data as any;
          console.log('[DATA STREAM] Single book image creation started:', singleStartData);
          
          const progressText = singleStartData.content?.currentStep && singleStartData.content?.totalSteps 
            ? ` (${singleStartData.content.currentStep}/${singleStartData.content.totalSteps})` 
            : '';
          setThinkingState(
            `🎨 Creating ${singleStartData.content?.imageType}: ${singleStartData.content?.name}${progressText}`, 
            'tool-progress'
          );
          break;

        case 'structured-book-image-progress':
          // Handle structured book image creation progress
          const imageProgressData = dataPart.data as any;
          console.log('[DATA STREAM] Structured book image progress:', imageProgressData);
          
          const stepLabel = imageProgressData.content?.step === 'character_portrait' ? 'Character Portrait' :
                           imageProgressData.content?.step === 'environment' ? 'Environment' : 'Scene';
          setThinkingState(
            `🎨 ${stepLabel}: ${imageProgressData.content?.item} (${imageProgressData.content?.stepNumber}/${imageProgressData.content?.totalSteps})`,
            'tool-progress'
          );
          break;

        case 'structured-book-image-result':
          // Handle structured book image creation result
          const resultData = dataPart.data as any;
          console.log('[DATA STREAM] Structured book image result:', resultData);
          
          if (resultData.content?.success) {
            const stepEmoji = resultData.content?.step === 'character_portrait' ? '👤' :
                             resultData.content?.step === 'environment' ? '🏞️' : '🎬';
            setThinkingState(
              `✅ ${stepEmoji} ${resultData.content?.item} ${resultData.content?.existingAsset ? '(existing)' : '(created)'}`,
              'tool-result-success'
            );
          } else {
            setThinkingState(`❌ Failed to create ${resultData.content?.item}`, 'tool-result-error');
          }
          break;

        case 'structured-book-image-complete':
          // Handle structured book image creation completion
          const completeData = dataPart.data as any;
          console.log('[DATA STREAM] Structured book image creation complete:', completeData);
          
          setThinkingState(
            `🎉 Created ${completeData.content?.results?.totalImagesCreated} images for "${completeData.content?.bookTitle}"`,
            'tool-result-success'
          );
          break;

        case 'single-book-image-complete':
          // Handle single book image creation completion
          const singleCompleteData = dataPart.data as any;
          console.log('[DATA STREAM] Single book image creation complete:', singleCompleteData);
          
          const completedImageType = singleCompleteData.content?.imageType;
          const completedName = singleCompleteData.content?.name;
          const completedProgressText = singleCompleteData.content?.currentStep && singleCompleteData.content?.totalSteps 
            ? ` (${singleCompleteData.content.currentStep}/${singleCompleteData.content.totalSteps})` 
            : '';
          
          setThinkingState(
            `✅ ${completedImageType?.charAt(0).toUpperCase() + completedImageType?.slice(1)}: ${completedName}${completedProgressText}`,
            'tool-result-success'
          );
          break;

        case 'single-book-image-auto-inserted':
          // Handle successful scene image auto-insertion
          const insertedData = dataPart.data as any;
          console.log('[DATA STREAM] Scene image auto-inserted:', insertedData);
          setThinkingState(
            `🎉 Scene image "${insertedData.content?.name}" automatically placed in book!`,
            'tool-result-success'
          );
          break;

        case 'single-book-image-auto-insert-failed':
          // Handle failed scene image auto-insertion
          const failedData = dataPart.data as any;
          console.log('[DATA STREAM] Scene image auto-insert failed:', failedData);
          setThinkingState(
            `⚠️ Scene image created but needs manual placement: ${failedData.content?.error}`,
            'tool-result-warning'
          );
          break;

        case 'single-book-image-auto-insert-error':
          // Handle scene image auto-insertion error
          const errorData = dataPart.data as any;
          console.log('[DATA STREAM] Scene image auto-insert error:', errorData);
          setThinkingState(
            `❌ Error auto-inserting scene image: ${errorData.content?.error}`,
            'tool-result-error'
          );
          break;

        case 'repository-created':
          // Handle repository creation success
          const repoCreatedData = dataPart.data as any;
          console.log('[DATA STREAM] Repository created successfully:', repoCreatedData);
          
          // Update thinking state
          if (repoCreatedData.message) {
            setThinkingState(repoCreatedData.message, 'repository-created');
          }
          
          // Update artifact with success state
          setArtifact((draftArtifact) => ({
            ...draftArtifact,
            kind: 'text',
            title: `Repository Created Successfully`,
            content: `✅ **Repository Created Successfully**

**Repository:** ${repoCreatedData.repository?.name}
**Owner:** ${repoCreatedData.repository?.owner}
**Description:** ${repoCreatedData.repository?.description}

🔗 **GitHub URL:** [${repoCreatedData.repository?.name}](${repoCreatedData.repository?.url})

${repoCreatedData.nextStep ? `**Next Step:** ${repoCreatedData.nextStep}` : ''}

The repository is now ready for project creation and file staging.`,
            status: 'idle',
            isVisible: true,
          }));
          break;





        default:
          console.log('[DATA STREAM] Unknown data type:', dataPart.type);
          break;
      }
    });
  }, [dataStream, setArtifact, setMetadata, setTitle, setThinkingState]);

  return null;
}
