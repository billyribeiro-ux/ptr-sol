// The desktop and marketplace clients share the same installation and account.
// Server-side authorization still validates every marketplace request.
(function () {
  try {
    var accountToken = localStorage.getItem('tokenSite');
    if (accountToken) localStorage.setItem('PTR_token', accountToken);
    else localStorage.removeItem('PTR_token');
  } catch (_) { /* Storage can be unavailable in private browsing. */ }
})();

// A course purchase uses a real linked membership plan, including its actual
// price and recurrence. An unlinked course cannot be checked out as a plan.
window.ptrCourseCheckout = async function (course, router, returnUrl) {
  var id = course && course.marketplaceID;
  var memberships = course && course.membershipIds;
  if (!id || !Array.isArray(memberships) || !memberships.length) {
    bootbox.alert('This course is not linked to a membership available for purchase.');
    return;
  }
  try {
    var response = await fetch('/ptr_app/mp/v2/public/marketplace/' + encodeURIComponent(id) + '/memberships');
    if (!response.ok) throw new Error('Membership listing unavailable');
    var plans = await response.json();
    var plan = plans.find(function (item) {
      return item.isActive !== false && memberships.some(function (memberId) {
        return String(memberId) === String(item._id || item.membershipId);
      });
    });
    if (!plan) throw new Error('No purchasable linked membership');
    router.navigate(['/subscription'], {state: {
      membership: plan, planName: plan.planName, description: plan.description,
      marketplace: {_id: id, title: course.name}, returnUrl: returnUrl,
      isCourse: true, courseId: course._id
    }});
  } catch (_) {
    bootbox.alert('A linked membership is not available for purchase. Please contact the course administrator.');
  }
};
