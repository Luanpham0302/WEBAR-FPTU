// Prints what is inside a compiled MindAR target file.
// Usage: node tools/inspect-targets.mjs public/targets/targets-poc.mind
import { readFileSync } from 'node:fs';
import { decode } from '@msgpack/msgpack';

const file = process.argv[2];

if (!file) {
  console.error('Usage: node tools/inspect-targets.mjs <file.mind>');
  process.exit(1);
}

const { v, dataList } = decode(readFileSync(file));

console.log(`${file}: format v${v}, ${dataList.length} targets`);
console.table(
  dataList.map((target, targetIndex) => {
    const matchingPoints = target.matchingData.map(
      (keyframe) => keyframe.maximaPoints.length + keyframe.minimaPoints.length,
    );

    return {
      targetIndex,
      size: `${target.targetImage.width}x${target.targetImage.height}`,
      matchingScales: matchingPoints.length,
      matchingPointsLargest: matchingPoints[0],
      matchingPointsTotal: matchingPoints.reduce((sum, count) => sum + count, 0),
      trackingPoints: target.trackingData
        .map((level) => level.points.length)
        .join(' / '),
    };
  }),
);
