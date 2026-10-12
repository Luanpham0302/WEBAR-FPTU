/// <reference types="vite/client" />

declare module 'mind-ar/dist/mindar-image-three.prod.js' {
  import type { Group, PerspectiveCamera, Scene, WebGLRenderer } from 'three';

  export class MindARThree {
    constructor(options: {
      container: HTMLElement;
      imageTargetSrc: string;
      maxTrack?: number;
      uiLoading?: 'yes' | 'no' | string;
      uiScanning?: 'yes' | 'no' | string;
      uiError?: 'yes' | 'no' | string;
      filterMinCF?: number;
      filterBeta?: number;
      warmupTolerance?: number;
      missTolerance?: number;
    });

    renderer: WebGLRenderer;
    scene: Scene;
    camera: PerspectiveCamera;
    // Created by start(); internal to MindAR.
    controller: unknown;

    addAnchor(targetIndex: number): {
      group: Group;
      onTargetFound?: () => void;
      onTargetLost?: () => void;
      onTargetUpdate?: () => void;
    };

    start(): Promise<void>;
    stop(): void;
  }
}
