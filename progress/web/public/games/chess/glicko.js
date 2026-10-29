// Glicko-2, the rating system Lichess uses, ported from widget/ChessCore.cs (Glicko2).
export const TAU = 0.75, DEFAULT_RATING = 1500, DEFAULT_DEVIATION = 500, DEFAULT_VOLATILITY = 0.09;
export const MIN_DEVIATION = 45, MAX_DEVIATION = 500, MAX_VOLATILITY = 0.1;
const SCALE = 173.7178, EPSILON = 0.000001;

const g = phi => 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));

/** One result against one opponent, clamped as the game uses it. player: {rating, deviation, volatility}. */
export function update(player, oppRating, oppDeviation, score) {
  const next = updateMany(player, [oppRating], [oppDeviation], [score], TAU);
  next.deviation = Math.max(MIN_DEVIATION, Math.min(MAX_DEVIATION, next.deviation));
  next.volatility = Math.min(MAX_VOLATILITY, next.volatility);
  return next;
}

/** Glickman's algorithm for one rating period; no clamping, so the paper's example can be checked. */
export function updateMany(player, oppRatings, oppDeviations, scores, tau) {
  const mu = (player.rating - 1500) / SCALE, phi = player.deviation / SCALE, sigma = player.volatility;
  let vInverse = 0, deltaSum = 0;
  for (let i = 0; i < oppRatings.length; i++) {
    const muJ = (oppRatings[i] - 1500) / SCALE, gj = g(oppDeviations[i] / SCALE);
    const e = 1 / (1 + Math.exp(-gj * (mu - muJ)));
    vInverse += gj * gj * e * (1 - e);
    deltaSum += gj * (scores[i] - e);
  }
  const v = 1 / vInverse, delta = v * deltaSum;
  const a = Math.log(sigma * sigma);
  const f = x => {
    const ex = Math.exp(x), d = phi * phi + v + ex;
    return ex * (delta * delta - phi * phi - v - ex) / (2 * d * d) - (x - a) / (tau * tau);
  };
  let A = a, B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A), fB = f(B);
  let guard = 0;
  while (Math.abs(B - A) > EPSILON && guard++ < 100) {
    const C = A + (A - B) * fA / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  const newSigma = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;
  return { rating: SCALE * newMu + 1500, deviation: SCALE * newPhi, volatility: newSigma };
}
