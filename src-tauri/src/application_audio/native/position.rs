//! Checked rational session milliseconds, private to the native reader. Keep
//! fractions until a consumer asks for a millisecond timestamp.
use crate::application_audio::timing::TimingError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Position {
    numerator: u128,
    denominator: u128,
}

impl Position {
    pub(super) fn new(numerator: u128, denominator: u128) -> Result<Self, TimingError> {
        if denominator == 0 {
            return Err(TimingError::Clock);
        }
        let divisor = gcd(numerator, denominator);
        let position = Self {
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        };
        position.millis()?;
        Ok(position)
    }

    pub(super) fn millis(self) -> Result<u64, TimingError> {
        u64::try_from(self.numerator / self.denominator).map_err(|_| TimingError::Overflow)
    }

    fn common(self, other: Self) -> Result<(u128, u128, u128), TimingError> {
        let divisor = gcd(self.denominator, other.denominator);
        let left_factor = other.denominator / divisor;
        let right_factor = self.denominator / divisor;
        Ok((
            self.numerator
                .checked_mul(left_factor)
                .ok_or(TimingError::Overflow)?,
            other
                .numerator
                .checked_mul(right_factor)
                .ok_or(TimingError::Overflow)?,
            self.denominator
                .checked_mul(left_factor)
                .ok_or(TimingError::Overflow)?,
        ))
    }

    pub(super) fn precedes(self, other: Self) -> Result<bool, TimingError> {
        let (left, right, _) = self.common(other)?;
        Ok(left < right)
    }

    /// A fixed linear mapping inside one delivered block, including its end.
    /// This is an interpolation policy, not a measurement of intermediate
    /// device times. Reject unrepresentable arithmetic rather than clamp it.
    pub(super) fn interpolate(
        self,
        end: Self,
        offset: u64,
        frames: u64,
    ) -> Result<Self, TimingError> {
        if frames == 0 || offset > frames {
            return Err(TimingError::Clock);
        }
        let (left, right, scale) = self.common(end)?;
        if right <= left {
            return Err(TimingError::Clock);
        }
        if offset == 0 {
            return Ok(self);
        }
        if offset == frames {
            return Ok(end);
        }
        let numerator = left
            .checked_mul(u128::from(frames))
            .and_then(|n| n.checked_add((right - left).checked_mul(u128::from(offset))?))
            .ok_or(TimingError::Overflow)?;
        let denominator = scale
            .checked_mul(u128::from(frames))
            .ok_or(TimingError::Overflow)?;
        Self::new(numerator, denominator)
    }
}

fn gcd(mut a: u128, mut b: u128) -> u128 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolation_keeps_distinct_denominators_and_rejects_unrepresentable_times() {
        let start = Position::new(2, 3).unwrap();
        let end = Position::new(13, 7).unwrap();
        assert_eq!(
            start.interpolate(end, 1, 2).unwrap(),
            Position::new(53, 42).unwrap()
        );
        assert_eq!(start.interpolate(end, 0, 2), Ok(start));
        assert_eq!(start.interpolate(end, 2, 2), Ok(end));
        assert_eq!(start.interpolate(end, 3, 2), Err(TimingError::Clock));
        assert_eq!(start.interpolate(end, 0, 0), Err(TimingError::Clock));
        assert_eq!(end.interpolate(start, 1, 2), Err(TimingError::Clock));
        assert_eq!(start.interpolate(start, 1, 2), Err(TimingError::Clock));
        assert_eq!(Position::new(1, 0), Err(TimingError::Clock));
        assert_eq!(
            Position::new(u128::from(u64::MAX) + 1, 1),
            Err(TimingError::Overflow)
        );
        // Both endpoints are valid, but the exact common scale isn't.
        let tiny = Position::new(1, u128::MAX).unwrap();
        assert_eq!(tiny.interpolate(start, 1, 2), Err(TimingError::Overflow));
    }
}
