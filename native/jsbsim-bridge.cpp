// The bridge between JSBSim (C++) and the game (JavaScript), compiled with JSBSim into one WebAssembly module by
// scripts/build-jsbsim.mjs. See src/fdm/jsbsim.ts for the typed wrapper the game uses.
//
// JSBSim is driven almost entirely through its property tree ("fcs/throttle-cmd-norm[0]", "position/h-agl-ft", ...), so the
// surface here is small: load an aircraft from the in-memory file system (the game writes the XML files there first), read and
// write properties (by name, or by a numeric handle for the per-step hot path), run initial conditions, step.
//
// The ground. JSBSim's default ground is the bare ellipsoid at one terrain elevation. Ours asks JavaScript: `setTerrain(fn)` installs
// fn(latitudeRad, longitudeRad) -> terrain height above the ellipsoid in METRES, and every contact point and every AGL computation
// in JSBSim then uses the game's own procedural terrain. The surface normal comes from finite differences of the same function.

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "FGFDMExec.h"
#include "input_output/FGGroundCallback.h"
#include "input_output/FGPropertyManager.h"
#include "math/FGColumnVector3.h"
#include "math/FGLocation.h"
#include "models/FGInertial.h"

using emscripten::val;
using namespace JSBSim;

namespace {

constexpr double FT_PER_M = 1.0 / 0.3048;

/** The terrain, as JavaScript defines it. Heights in metres in the callback, feet inside JSBSim. */
class JsGround : public FGGroundCallback {
 public:
  JsGround(double semiMajor, double semiMinor) : a(semiMajor), b(semiMinor) {}

  void setFunction(val f) { fn = f; }

  double GetAGLevel(double t, const FGLocation& loc, FGLocation& contact, FGColumnVector3& normal, FGColumnVector3& vel,
                    FGColumnVector3& angularVel) const override {
    vel.InitMatrix();
    angularVel.InitMatrix();
    FGLocation l = loc;
    l.SetEllipse(a, b);
    const double lat = l.GetGeodLatitudeRad();
    const double lon = l.GetLongitude();
    const double h = heightFt(lat, lon);

    // Normal: local gradient over one metre north and east, then the (north, east, up) vector rotated into ECEF.
    const double R = a;  // (a metre in latitude/longitude near our small patch of planet; the precise radius does not matter here)
    const double step = 1.0 * FT_PER_M;
    const double dLat = step / R;
    const double dLon = step / (R * std::max(std::cos(lat), 1e-6));
    const double dhdN = (heightFt(lat + dLat, lon) - h) / step;
    const double dhdE = (heightFt(lat, lon + dLon) - h) / step;
    double nN = -dhdN, nE = -dhdE, nU = 1.0;
    const double len = std::sqrt(nN * nN + nE * nE + nU * nU);
    nN /= len, nE /= len, nU /= len;
    const double sLat = std::sin(lat), cLat = std::cos(lat), sLon = std::sin(lon), cLon = std::cos(lon);
    normal = FGColumnVector3(nU * cLat * cLon - nN * sLat * cLon - nE * sLon,
                             nU * cLat * sLon - nN * sLat * sLon + nE * cLon,
                             nU * sLat + nN * cLat);

    contact.SetEllipse(a, b);
    contact.SetPositionGeodetic(lon, lat, h);
    return l.GetGeodAltitude() - h;
  }

  void SetEllipse(double semiMajor, double semiMinor) override {
    a = semiMajor;
    b = semiMinor;
  }

 private:
  double heightFt(double lat, double lon) const {
    if (fn.isUndefined() || fn.isNull()) return 0.0;
    return fn(lat, lon).as<double>() * FT_PER_M;
  }

  double a, b;
  val fn = val::undefined();
};

}  // namespace

/** One JSBSim instance (an aircraft in its world). */
class Sim {
 public:
  Sim() : fdm(std::make_unique<FGFDMExec>()) {
    fdm->SetDebugLevel(0);
    fdm->SetRootDir(SGPath("/jsbsim"));
    fdm->SetAircraftPath(SGPath("aircraft"));
    fdm->SetEnginePath(SGPath("engine"));
    fdm->SetSystemsPath(SGPath("systems"));
    auto inertial = fdm->GetInertial();
    ground = new JsGround(inertial->GetSemimajor(), inertial->GetSemiminor());
    inertial->SetGroundCallback(ground);  // (owned by FGInertial from here on)
  }

  /** Load /jsbsim/aircraft/<name>/<name>.xml. False (and `lastError()`) on failure. */
  bool loadModel(const std::string& name) {
    return guard([&] { return fdm->LoadModel(name); });
  }

  void setDt(double dt) { fdm->Setdt(dt); }
  double getDt() const { return fdm->GetDeltaT(); }
  double simTime() const { return fdm->GetSimTime(); }

  bool runIC() {
    return guard([&] { return fdm->RunIC(); });
  }

  bool run() {
    return guard([&] { return fdm->Run(); });
  }

  /** Run `n` steps; returns how many ran (fewer only if JSBSim asked to stop or threw). */
  int steps(int n) {
    int done = 0;
    guard([&] {
      for (; done < n; ++done)
        if (!fdm->Run()) break;
      return true;
    });
    return done;
  }

  double get(const std::string& name) {
    double v = NAN;
    guard([&] {
      v = fdm->GetPropertyValue(name);
      return true;
    });
    return v;
  }

  void set(const std::string& name, double value) {
    guard([&] {
      fdm->SetPropertyValue(name, value);
      return true;
    });
  }

  bool has(const std::string& name) { return fdm->GetPropertyManager()->HasNode(name); }

  /** A numeric handle for a property (created if missing), for fast get/set every step. -1 on failure. */
  int handle(const std::string& name) {
    int id = -1;
    guard([&] {
      SGPropertyNode* node = fdm->GetPropertyManager()->GetNode(name, true);
      if (!node) return false;
      nodes.push_back(node);
      id = static_cast<int>(nodes.size()) - 1;
      return true;
    });
    return id;
  }

  double getH(int h) const { return nodes[h]->getDoubleValue(); }
  void setH(int h, double v) { nodes[h]->setDoubleValue(v); }

  void setTerrain(val fn) { ground->setFunction(fn); }

  /** Every property path, one per line (for debugging and tests). */
  std::string propertyCatalog() {
    std::string out;
    guard([&] {
      for (const auto& p : fdm->GetPropertyCatalog()) out += p + "\n";
      return true;
    });
    return out;
  }

  std::string lastError() const { return error; }

 private:
  template <class F>
  bool guard(F&& f) {
    try {
      error.clear();
      return f();
    } catch (const std::exception& e) {
      error = e.what();
    } catch (const std::string& s) {
      error = s;
    } catch (const char* s) {
      error = s;
    } catch (...) {
      error = "unknown JSBSim exception";
    }
    return false;
  }

  std::unique_ptr<FGFDMExec> fdm;
  JsGround* ground;
  std::vector<SGPropertyNode*> nodes;
  std::string error;
};

EMSCRIPTEN_BINDINGS(jsbsim) {
  emscripten::class_<Sim>("Sim")
      .constructor<>()
      .function("loadModel", &Sim::loadModel)
      .function("setDt", &Sim::setDt)
      .function("getDt", &Sim::getDt)
      .function("simTime", &Sim::simTime)
      .function("runIC", &Sim::runIC)
      .function("run", &Sim::run)
      .function("steps", &Sim::steps)
      .function("get", &Sim::get)
      .function("set", &Sim::set)
      .function("has", &Sim::has)
      .function("handle", &Sim::handle)
      .function("getH", &Sim::getH)
      .function("setH", &Sim::setH)
      .function("setTerrain", &Sim::setTerrain)
      .function("propertyCatalog", &Sim::propertyCatalog)
      .function("lastError", &Sim::lastError);
  emscripten::function("version", emscripten::optional_override([]() { return std::string(JSBSIM_VERSION); }));
}
