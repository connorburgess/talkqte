//! Which listed applications a person would recognise, and in what order.
//!
//! ScreenCaptureKit lists every process that can be captured, including
//! background agents, view services and helper processes. Only a regular
//! application (one with a Dock presence) that has a bundle identifier and
//! at least one on-screen window is offered. Its helpers, whose bundle
//! identifiers extend its own, are captured with it rather than listed.
//! Whether an application is playing audio cannot be told from the listing.

use super::Application;

/// What the listing knows about one application, beyond its name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Traits {
    pub bundle_id: String,
    /// The activation policy is regular: it appears in the Dock.
    pub regular: bool,
    /// At least one of its windows is on screen, at the normal window level.
    pub on_screen: bool,
}

/// Meeting and playback applications, listed first, in this order.
const FIRST: &[(&str, &str)] = &[
    ("us.zoom.xos", "zoom.us"),
    ("com.microsoft.teams2", "Microsoft Teams"),
    ("com.microsoft.teams", "Microsoft Teams"),
    ("com.cisco.webexmeetingsapp", "Webex"),
    ("Cisco-Systems.Spark", "Webex"),
    ("com.apple.FaceTime", "FaceTime"),
    ("com.tinyspeck.slackmacgap", "Slack"),
    ("com.google.Chrome", "Google Chrome"),
    ("com.google.chrome.for.testing", "Google Chrome for Testing"),
    ("com.apple.Safari", "Safari"),
    ("company.thebrowser.Browser", "Arc"),
    ("org.mozilla.firefox", "Firefox"),
    ("com.apple.QuickTimePlayerX", "QuickTime Player"),
];

/// Whether a person would recognise this application in the list. Without
/// traits, as in a fixture, nothing is known against it.
pub fn recognisable(traits: Option<&Traits>) -> bool {
    traits.is_none_or(|traits| {
        traits.regular && !traits.bundle_id.trim().is_empty() && traits.on_screen
    })
}

/// Whether `candidate` is a helper of the application with bundle
/// identifier `owner`: not itself regular, and its identifier extends the
/// owner's, as `com.example.Browser.helper` extends `com.example.Browser`.
pub fn helper_of(owner: &str, candidate: &Traits) -> bool {
    !owner.is_empty()
        && !candidate.regular
        && candidate
            .bundle_id
            .strip_prefix(owner)
            .is_some_and(|rest| rest.len() > 1 && rest.starts_with('.'))
}

fn rank(application: &Application) -> usize {
    FIRST
        .iter()
        .position(|(bundle, name)| match application.traits() {
            Some(traits) => traits.bundle_id == *bundle,
            None => application.name() == *name,
        })
        .unwrap_or(FIRST.len())
}

/// The applications to offer: recognisable ones only, meeting and playback
/// applications first, then the rest by name.
pub fn shown(applications: Vec<Application>) -> Vec<Application> {
    let mut shown: Vec<_> = applications
        .into_iter()
        .filter(|application| recognisable(application.traits()))
        .collect();
    shown.sort_by_cached_key(|application| (rank(application), application.name().to_lowercase()));
    shown
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: usize, name: &str, bundle: &str, regular: bool, on_screen: bool) -> Application {
        Application::new(format!("fictional-{id}"), name.into())
            .unwrap()
            .with_traits(Traits {
                bundle_id: bundle.into(),
                regular,
                on_screen,
            })
    }

    #[test]
    fn only_regular_applications_with_a_bundle_and_a_window_are_offered_in_a_useful_order() {
        let listed = vec![
            app(0, "Notes", "com.apple.Notes", true, true),
            app(1, "Dock", "com.apple.dock", false, true),
            app(2, "talagentd", "com.apple.talagent", false, false),
            app(
                3,
                "CursorUIViewService",
                "com.apple.TextInputUI.xpc.CursorUIViewService",
                false,
                true,
            ),
            app(4, "Control Center", "com.apple.controlcenter", false, true),
            app(5, "Stats", "eu.exelban.Stats", false, true),
            app(
                6,
                "QuickTime Player",
                "com.apple.QuickTimePlayerX",
                true,
                true,
            ),
            app(
                7,
                "ThemeWidgetControlViewService (Google Chrome)",
                "com.google.Chrome.helper",
                false,
                false,
            ),
            app(8, "Google Chrome", "com.google.Chrome", true, true),
            app(9, "Calendar", "com.apple.iCal", true, false),
            app(10, "Fictional tool", "", true, true),
            app(11, "zoom.us", "us.zoom.xos", true, true),
            app(12, "atlas", "org.example.atlas", true, true),
        ];
        let names: Vec<_> = shown(listed)
            .iter()
            .map(|application| application.name().to_owned())
            .collect();
        assert_eq!(
            names,
            [
                "zoom.us",
                "Google Chrome",
                "QuickTime Player",
                "atlas",
                "Notes"
            ]
        );
    }

    #[test]
    fn a_browsers_helpers_fold_into_it_and_nothing_else_does() {
        let helper = |bundle: &str, regular| Traits {
            bundle_id: bundle.into(),
            regular,
            on_screen: false,
        };
        let chrome = "com.google.Chrome";
        assert!(helper_of(
            chrome,
            &helper("com.google.Chrome.helper", false)
        ));
        assert!(helper_of(
            chrome,
            &helper("com.google.Chrome.helper.Renderer", false)
        ));
        // A different application that only shares the prefix text.
        assert!(!helper_of(
            chrome,
            &helper("com.google.ChromeRemoteDesktop", false)
        ));
        // A regular application is listed in its own right.
        assert!(!helper_of(
            chrome,
            &helper("com.google.Chrome.canary", true)
        ));
        assert!(!helper_of(chrome, &helper(chrome, false)));
        assert!(!helper_of("", &helper("com.google.Chrome.helper", false)));
    }

    #[test]
    fn without_traits_an_application_is_offered_and_known_names_still_come_first() {
        let plain =
            |id: usize, name: &str| Application::new(format!("plain-{id}"), name.into()).unwrap();
        let names: Vec<_> = shown(vec![plain(0, "Atlas"), plain(1, "QuickTime Player")])
            .iter()
            .map(|application| application.name().to_owned())
            .collect();
        assert_eq!(names, ["QuickTime Player", "Atlas"]);
    }
}
